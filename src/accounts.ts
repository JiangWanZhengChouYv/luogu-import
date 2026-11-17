/**
 * 按 Hydro 用户保存的「提交账号」（与全站「拉题账号」完全隔离）。
 *
 * luogu.accounts 每个文档 _id = Hydro uid；clientId 用 config.ts 的同一套
 * AES-256-GCM 加密（密钥在 data/backend/luogu.key），洛谷公开资料（用户名/头像等）
 * 以明文缓存，供再次打开系统时自动展示。
 */
import { Logger } from 'hydrooj';
import { decryptSecret, encryptSecret } from './config';

const logger = new Logger('luogu-import/accounts');

let coll: any = null;

export interface LuoguProfile {
    uid: string;
    uname: string;
    avatar: string;
    home: string;
    color?: string;
    slogan?: string;
    ranking?: number;
    passed?: number;
    submitted?: number;
    verifiedAt?: number;
}

export interface AccountInfo {
    configured: boolean;
    luoguUid?: string;
    clientIdLength?: number;
    profile?: LuoguProfile;
    updatedAt?: number;
    message?: string;
}

export interface SubmitCredentials {
    uid: string;
    clientId: string;
    profile?: LuoguProfile;
}

export function initAccounts(collection: any) {
    coll = collection;
}

function db() {
    if (!coll) throw new Error('提交账号存储未初始化（数据库不可用）');
    return coll;
}

function docId(hydroUid: number | string) {
    return String(hydroUid);
}

function assertShape(luoguUid: string, clientId: string) {
    if (!/^\d{1,12}$/.test(luoguUid)) throw new Error('_uid 必须是数字（洛谷浏览器 Cookie 里的 _uid）');
    if (!clientId || clientId.length < 8 || clientId.length > 128) {
        throw new Error('__client_id 格式不正确（应为浏览器 Cookie 里的客户端 ID）');
    }
}

export async function saveAccount(hydroUid: number, luoguUidRaw: string, clientIdRaw: string): Promise<AccountInfo> {
    const luoguUid = String(luoguUidRaw || '').trim();
    const clientId = String(clientIdRaw || '').trim();
    assertShape(luoguUid, clientId);
    const secret = encryptSecret(clientId);
    await db().updateOne(
        { _id: docId(hydroUid) },
        {
            $set: { luoguUid, secret, updatedAt: Date.now() },
            $unset: { profile: '' },
        },
        { upsert: true },
    );
    // 只记录 uid 与长度，绝不记录值
    logger.info('submit account saved: hydro uid %s -> luogu uid %s (clientId length %d)',
        hydroUid, luoguUid, clientId.length);
    return getAccountInfo(hydroUid);
}

export async function loadAccount(hydroUid: number): Promise<SubmitCredentials | null> {
    const doc = await db().findOne({ _id: docId(hydroUid) });
    if (!doc?.luoguUid || !doc?.secret) return null;
    try {
        return {
            uid: String(doc.luoguUid),
            clientId: decryptSecret(doc.secret),
            profile: doc.profile || undefined,
        };
    } catch {
        logger.warn('submit account decrypt failed for hydro uid %s', hydroUid);
        return null;
    }
}

export async function clearAccount(hydroUid: number): Promise<void> {
    await db().deleteOne({ _id: docId(hydroUid) });
    logger.info('submit account cleared for hydro uid %s', hydroUid);
}

export async function saveProfile(hydroUid: number, profile: LuoguProfile): Promise<void> {
    await db().updateOne(
        { _id: docId(hydroUid) },
        { $set: { profile, verifiedAt: Date.now() } },
    );
}

export async function getAccountInfo(hydroUid: number): Promise<AccountInfo> {
    const doc = await db().findOne({ _id: docId(hydroUid) });
    if (!doc?.luoguUid || !doc?.secret) return { configured: false };
    try {
        const clientId = decryptSecret(doc.secret);
        return {
            configured: true,
            luoguUid: String(doc.luoguUid),
            clientIdLength: clientId.length,
            profile: doc.profile || undefined,
            updatedAt: doc.updatedAt,
        };
    } catch {
        return {
            configured: false,
            message: '已保存的提交账号无法解密（密钥可能已更换），请重新绑定',
        };
    }
}
