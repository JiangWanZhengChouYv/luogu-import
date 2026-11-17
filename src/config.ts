/**
 * 洛谷登录凭据的加密存取。
 *
 * 密文存 Mongo（luogu.config），AES-256-GCM 密钥放在 /root/.hydro/luogu.key
 * （宿主机 data/backend/luogu.key，gitignore，权限 600），两者分离。
 * 也可以用环境变量 LUOGU_ENC_KEY 提供 32 字节密钥（hex 或 base64）。
 *
 * 红线：cookie 值绝不写日志、绝不回显、绝不进仓库。对外只暴露
 * uid 和 clientId 的长度。
 */
import crypto from 'crypto';
import fs from 'fs';
import { Logger } from 'hydrooj';

const logger = new Logger('luogu-import/config');

const KEY_FILE = '/root/.hydro/luogu.key';
const DOC_ID = 'credentials';

let coll: any = null;
let cachedKey: Buffer | null = null;

/** 由插件 apply() 注入 Mongo collection，避免模块间循环依赖 */
export function initConfig(collection: any) {
    coll = collection;
}

function ensureColl() {
    if (!coll) throw new Error('凭据存储未初始化（数据库不可用）');
    return coll;
}

function loadKey(): Buffer {
    if (cachedKey) return cachedKey;
    const env = process.env.LUOGU_ENC_KEY;
    if (env) {
        const raw = env.trim();
        const buf = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
        if (buf.length !== 32) throw new Error('LUOGU_ENC_KEY 必须是 32 字节密钥（hex 或 base64）');
        cachedKey = buf;
        return buf;
    }
    try {
        const buf = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
        if (buf.length !== 32) throw new Error('invalid key file');
        cachedKey = buf;
        return buf;
    } catch {
        const buf = crypto.randomBytes(32);
        try {
            fs.writeFileSync(KEY_FILE, buf.toString('hex'), { flag: 'wx', mode: 0o600 });
            fs.chmodSync(KEY_FILE, 0o600);
        } catch (e) {
            // 其他进程刚刚创建了密钥，重新读取即可
            if (e && (e as any).code === 'EEXIST') {
                const existing = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
                if (existing.length !== 32) throw new Error('密钥文件损坏，请删除后重新配置登录');
                cachedKey = existing;
                return existing;
            }
            throw e;
        }
        cachedKey = buf;
        logger.info('generated credentials encryption key at %s', KEY_FILE);
        return buf;
    }
}

export interface Sealed {
    enc: string;
    iv: string;
    tag: string;
}

function seal(plain: string): Sealed {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
        enc: enc.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
    };
}

function unseal(data: Sealed): string {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm', loadKey(), Buffer.from(data.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(data.enc, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

/** 供按用户提交账号复用同一套加密（密钥与密文分离） */
export function encryptSecret(plain: string): Sealed {
    return seal(plain);
}

export function decryptSecret(data: Sealed): string {
    return unseal(data);
}

export interface Credentials {
    uid: string;
    clientId: string;
}

export interface PublicConfig {
    configured: boolean;
    uid?: string;
    clientIdLength?: number;
    keySource?: 'env' | 'file';
    updatedAt?: number;
    message?: string;
}

/** 校验输入格式，不打印任何值 */
function assertShape(uid: string, clientId: string) {
    if (!/^\d{1,12}$/.test(uid)) throw new Error('_uid 必须是数字（浏览器 Cookie 里的 _uid）');
    if (!clientId || clientId.length < 8 || clientId.length > 128) {
        throw new Error('__client_id 格式不正确（应为浏览器 Cookie 里的客户端 ID）');
    }
}

export async function saveCredentials(uidRaw: string, clientIdRaw: string): Promise<PublicConfig> {
    const uid = String(uidRaw || '').trim();
    const clientId = String(clientIdRaw || '').trim();
    assertShape(uid, clientId);
    // 先验证密钥可用，避免把无法解密的密文写进库
    loadKey();
    const secret = seal(clientId);
    await ensureColl().updateOne(
        { _id: DOC_ID },
        { $set: { uid, secret, updatedAt: Date.now() } },
        { upsert: true },
    );
    logger.info('credentials saved for uid %s (clientId length %d)', uid, clientId.length);
    return getPublicConfig();
}

export async function loadCredentials(): Promise<Credentials | null> {
    const doc = await ensureColl().findOne({ _id: DOC_ID });
    if (!doc?.uid || !doc?.secret) return null;
    try {
        return { uid: String(doc.uid), clientId: unseal(doc.secret) };
    } catch (e) {
        // 只记录「解密失败」，绝不记录密文或异常里的值
        logger.warn('credentials decrypt failed; please reconfigure Luogu login');
        return null;
    }
}

export async function clearCredentials(): Promise<void> {
    await ensureColl().deleteOne({ _id: DOC_ID });
    logger.info('credentials cleared');
}

export async function getPublicConfig(): Promise<PublicConfig> {
    const doc = await ensureColl().findOne({ _id: DOC_ID });
    const keySource = process.env.LUOGU_ENC_KEY ? 'env' : 'file';
    if (!doc?.uid || !doc?.secret) {
        return { configured: false, keySource };
    }
    try {
        const clientId = unseal(doc.secret);
        return {
            configured: true,
            uid: String(doc.uid),
            clientIdLength: clientId.length,
            keySource,
            updatedAt: doc.updatedAt,
        };
    } catch {
        return {
            configured: false,
            keySource,
            message: '已保存的登录态无法解密（密钥可能已更换），请重新配置',
        };
    }
}
