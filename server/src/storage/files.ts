import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { hmac, safeEqual, sha256hex } from '../util/crypto.js';

/**
 * Private object storage on the local filesystem (outside any web root). In production this
 * directory should sit on an encrypted volume, or be replaced by a private bucket with
 * server-side encryption; the interface is deliberately small to make that swap easy.
 */
export async function putObject(orgId: string, data: Buffer) {
  const now = new Date();
  const key = `${orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  return { key, sha256: sha256hex(data), size: data.length };
}

export async function getObject(key: string) {
  return readFile(pathFor(key));
}

function pathFor(key: string) {
  if (!/^[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid storage key');
  const root = resolve(config.STORAGE_DIR);
  const p = resolve(join(root, key));
  if (!p.startsWith(root)) throw new Error('invalid storage key');
  return p;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MIME = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', xlsx: XLSX_MIME, csv: 'text/csv', eml: 'message/rfc822', text: 'text/plain' };

/**
 * Determines the real file type from its content (magic bytes), ignoring the client-supplied
 * name and content type. Returns null for anything not on the allow-list.
 */
export function sniff(data: Buffer, filename: string): { mime: string; ext: string } | null {
  const lower = filename.toLowerCase();
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: MIME.pdf, ext: 'pdf' };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: MIME.png, ext: 'png' };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: MIME.jpeg, ext: 'jpg' };
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    if (lower.endsWith('.xlsx') || data.includes(Buffer.from('xl/'))) return { mime: XLSX_MIME, ext: 'xlsx' };
    return null; // other zip containers (docx, xlsm with macros declared differently, archives) are refused
  }
  const head = data.subarray(0, 4096).toString('utf8');
  if (!/[\u0000-\u0008\u000e-\u001f]/.test(head)) {
    if (lower.endsWith('.csv')) return { mime: MIME.csv, ext: 'csv' };
    if (lower.endsWith('.eml') || /^(received|from|return-path|message-id|mime-version|date|subject|to|delivered-to|x-[\w-]+):/im.test(head)) {
      return { mime: MIME.eml, ext: 'eml' };
    }
    if (lower.endsWith('.txt')) return { mime: MIME.text, ext: 'txt' };
  }
  return null;
}

export function safeFilename(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 150);
}

export type ScanResult = { status: 'clean' | 'infected' | 'scan_failed' | 'quarantined'; detail: string };

/**
 * Malware scanning via clamd (INSTREAM). Without a scanner, files stay quarantined and
 * cannot be downloaded or processed. The dev-allow-all mode exists only for local
 * development and is refused in production by config.ts.
 */
export async function scanForMalware(data: Buffer): Promise<ScanResult> {
  if (config.MALWARE_SCAN_MODE === 'dev-allow-all') return { status: 'clean', detail: 'dev_mode_not_scanned' };
  if (config.MALWARE_SCAN_MODE === 'none') return { status: 'quarantined', detail: 'no_scanner_configured' };
  return new Promise((resolvePromise) => {
    const sock = createConnection({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT });
    let reply = '';
    sock.setTimeout(30_000);
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 64 * 1024) {
        const chunk = data.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => {
      if (/OK\0?$/.test(reply.trim())) resolvePromise({ status: 'clean', detail: 'clamav' });
      else if (/FOUND/.test(reply)) resolvePromise({ status: 'infected', detail: reply.replace(/\0/g, '').slice(0, 200) });
      else resolvePromise({ status: 'scan_failed', detail: reply.slice(0, 200) });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolvePromise({ status: 'scan_failed', detail: 'timeout' });
    });
    sock.on('error', (e) => resolvePromise({ status: 'scan_failed', detail: e.message }));
  });
}

/* Short-lived download links ------------------------------------------------------------ */

export interface LinkClaims {
  kind: 'document' | 'attachment' | 'package_eml';
  id: string;
  org: string;
  sid: string;
  exp: number;
}

export function signLink(c: Omit<LinkClaims, 'exp'>, ttlSeconds = 60) {
  const body = Buffer.from(JSON.stringify({ ...c, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function verifyLink(token: string): LinkClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as LinkClaims;
    if (c.exp < Math.floor(Date.now() / 1000)) return null;
    return c;
  } catch {
    return null;
  }
}
