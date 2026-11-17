/**
 * 反算样例：把用户在洛谷 AC 的代码当标程，利用 Hydro 自带的 generate 判题器
 * （生成器造输入 + 标程算输出）重算题目测试点。
 *
 * 2026-11-16 重做（用户反馈「反算出来的样例还是不够极限」）：
 *   旧版默认 scale=1 → 生成数据只有样例那么大（样例 n=3，题面 n≤1e4），
 *   半限门限只「拒绝太慢的数据」，从不把数据往极限推，所以永远不够狠。
 *   新版改成「按题面数据范围反算极限规模」：
 *     1. 从题面「提示/数据范围」解析 n 的上界与值域上界；
 *     2. 生成器按样例结构（n 行 / n m 行 / 单个数 / 行内数组 / 尾行）放大到上界；
 *     3. 10 组用不同 profile（最小、随机、升序、降序、全值域最大），覆盖边界；
 *     4. generate 的限制用题面限制的 90%，标程在真实上界跑不过就退一档重试；
 *     5. 逐组判定，成功 ≥6 组即视为完成（不再因为某一组边界数据不合法就全丢）。
 *
 * 已知边界：hit 不到时间上限的 O(1) 题（如 A+B）属于正常；memory 上限被 judge
 * 的 generate 实现写死为 256MB，无法在这里打满内存。
 */
import { createHash } from 'crypto';
import { Logger, ObjectId, ProblemModel, RecordModel } from 'hydrooj';
import { predictRange } from './rangeModel';

const logger = new Logger('luogu-import/oracle');

const SUBMISSIONS = 'luogu.submissions';
const ORACLES = 'luogu.oracle';
const FIXES = 'luogu.samplefix';

let db: any = null;

export function initOracle(mongo: any) {
    db = mongo;
}

function coll(name: string) {
    if (!db) throw new Error('数据库未就绪，无法使用反算样例功能');
    return db.collection(name);
}

function hashOf(code: string) {
    return createHash('sha256').update(code).digest('hex');
}

/** 提交时留档：rid 是洛谷 rid，之后拿到 AC 时用它取回代码当标程 */
export async function saveSubmission(data: {
    rid: string;
    localRid?: string;
    domainId: string;
    docId: number;
    uid: number;
    code: string;
    lang: string;
}) {
    await coll(SUBMISSIONS).updateOne(
        { _id: data.rid },
        {
            $set: {
                ...data,
                submittedAt: Date.now(),
                hash: hashOf(data.code),
            },
        },
        { upsert: true },
    );
}

export async function getSubmission(rid: string): Promise<any | null> {
    return coll(SUBMISSIONS).findOne({ _id: String(rid) });
}

export async function setLocalRid(rid: string, localRid: string) {
    await coll(SUBMISSIONS).updateOne({ _id: String(rid) }, { $set: { localRid } });
}

/**
 * 只在洛谷 AC 时保存标程。按 (domainId, docId) 一份，
 * 同一 hash 不重复写，避免无谓的重算。
 */
export async function saveOracle(
    domainId: string, docId: number, uid: number, code: string, rid: string,
): Promise<{ changed: boolean; hash: string }> {
    const hash = hashOf(code);
    const key = `${domainId}/${docId}`;
    const old = await coll(ORACLES).findOne({ _id: key });
    if (old?.hash === hash) return { changed: false, hash };
    await coll(ORACLES).updateOne(
        { _id: key },
        { $set: { domainId, docId, uid, rid, code, hash, updatedAt: Date.now() } },
        { upsert: true },
    );
    return { changed: true, hash };
}

export async function getOracle(domainId: string, docId: number): Promise<any | null> {
    return coll(ORACLES).findOne({ _id: `${domainId}/${docId}` });
}

/* ------------------------------------------------------------------ *
 * 题面数据范围解析
 * ------------------------------------------------------------------ */

export interface LuoguLimits {
    /** 题面里规模变量 n/N 的上界；解析不到为 null */
    n: number | null;
    /** 值域上界（|a_i| ≤ x），解析不到按 1e9 */
    valueMax: number;
    /** 解析到的原始上界列表，便于排查 */
    bounds: number[];
}

function parseMagToken(tok: string): number | null {
    const t = String(tok).replace(/\s+/g, '');
    let m = t.match(/^(\d+(?:\.\d+)?)\*10\^(\d+)$/);
    if (m) return Math.round(Number(m[1]) * (10 ** Number(m[2])));
    m = t.match(/^10\^(\d+)$/);
    if (m) return 10 ** Number(m[1]);
    m = t.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
    return null;
}

/** 把题面 markdown 里数学公式/转义整理成可正则的纯文本 */
function normalizeStatement(md: string): string {
    let s = String(md || '');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/\$([^$]*)\$/g, ' $1 ');
    // 注意不能用 \b：`\le15` 这种「紧跟数字」的写法里 e 与 1 都是词字符，\b 不成立，
    // 会把上界整个吃掉（P1094 的 `1\le n\le3\times10^4` 就是这样解析失败的）。
    s = s.replace(/\\le(q|qslant)?(?![a-zA-Z])/g, ' <= ')
        .replace(/\\ge(q|qslant)?(?![a-zA-Z])/g, ' >= ')
        .replace(/\\times|\\cdot/g, ' * ')
        .replace(/\\[a-zA-Z]+\*?/g, ' ')
        .replace(/[{}\\]/g, ' ')
        .replace(/[≤]/g, ' <= ')
        .replace(/[≥]/g, ' >= ')
        .replace(/[×·]/g, ' * ')
        .replace(/\s+/g, ' ')
        .trim();
    return s;
}

/** 从题面解析数据范围（优先「提示 / 数据范围 / 说明」段） */
export function parseConstraints(md: string): LuoguLimits {
    const full = normalizeStatement(md);
    let region = full;
    const idx = Math.max(
        full.lastIndexOf('数据范围'),
        full.lastIndexOf('提示'),
        full.lastIndexOf('说明'),
    );
    if (idx >= 0) region = full.slice(idx);

    const entries: Array<{ vars: string[]; bound: number }> = [];
    const push = (varsRaw: string, boundRaw: string) => {
        const vars = varsRaw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        const bound = parseMagToken(boundRaw);
        if (bound && Number.isFinite(bound) && bound > 0) entries.push({ vars, bound });
    };

    // 链式写法 1 <= n <= 3*10^4：只取上界（先匹配，避免被下面的单侧规则取到下界）
    const reChain = /(?:\d+(?:\.\d+)?\s*\*\s*10\s*\^\s*\d+|10\s*\^\s*\d+|\d+(?:\.\d+)?)\s*(?:<=|<)\s*([A-Za-z][A-Za-z0-9_]{0,15})\s*(?:<=|<)\s*((?:\d+(?:\.\d+)?\s*\*\s*10\s*\^\s*\d+)|(?:10\s*\^\s*\d+)|(?:\d+(?:\.\d+)?))/g;
    let mc: RegExpExecArray | null;
    while ((mc = reChain.exec(region)) !== null) push(mc[1], mc[2]);
    // a, b, c <= 10^5  /  n <= 1e5
    const re1 = /([A-Za-z][A-Za-z0-9_]{0,15}(?:\s*[,，、]\s*[A-Za-z][A-Za-z0-9_]{0,15})*)\s*(?:<=|<)\s*((?:\d+(?:\.\d+)?\s*\*\s*10\s*\^\s*\d+)|(?:10\s*\^\s*\d+)|(?:\d+(?:\.\d+)?))/g;
    let m: RegExpExecArray | null;
    while ((m = re1.exec(region)) !== null) push(m[1], m[2]);
    // 10^5 >= n
    const re2 = /((?:\d+(?:\.\d+)?\s*\*\s*10\s*\^\s*\d+)|(?:10\s*\^\s*\d+)|(?:\d+(?:\.\d+)?))\s*(?:>=|>)\s*([A-Za-z][A-Za-z0-9_]{0,15}(?:\s*[,，、]\s*[A-Za-z][A-Za-z0-9_]{0,15})*)/g;
    while ((m = re2.exec(region)) !== null) push(m[2], m[1]);

    const all = entries.map((e) => e.bound);
    const nBounds = entries
        .filter((e) => e.vars.some((v) => /^(n|N|len|length|size)$/.test(v)))
        .map((e) => e.bound)
        .filter((x) => x >= 1 && x <= 5_000_000);
    const n = nBounds.length ? Math.max(...nBounds) : null;
    const valueCandidates = all.filter((x) => x >= 2 && x <= 1_000_000_000);
    const valueMax = valueCandidates.length ? Math.max(...valueCandidates) : 1_000_000_000;
    return { n, valueMax, bounds: Array.from(new Set(all)).sort((a, b) => a - b) };
}

/* ------------------------------------------------------------------ *
 * 生成器
 * ------------------------------------------------------------------ */

/**
 * 按题面结构造数据。
 *
 * 识别到的结构（其余退化为「只随机值、不改规模」）：
 *   SINGLE_NUM    只有一个数 n           → 直接输出上界（如「求 n!」）
 *   INLINE_ARR    一行 n a1..an          → 输出 n 个数
 *   N_LINES       首行 n，后接 n 行数据   → 输出上界行数
 *   N_TAIL        首行 n，n 行数据 + 尾行 → 同上，尾行原样保留（如查询行 / 00 终止）
 *   NM_LINES      首行 n m，后接 n 行     → 放大 n，m 不变
 *   NM_TAIL       同上 + 尾行
 *   N_THEN_INLINE 首行 n，第二行 m，一行 m 个数 → n、m 一起放大
 *   NM_COORDS     一行 n m x y（坐标题）  → n、m 放大，坐标按 n,m 取
 *
 * 第 1 组是最小规模（边界），2..6 随机，7 升序，8 降序，9 全值域最大。
 */
function generatorCpp(targetN: number, valueMax: number, countCap = 0): string {
    const capN = Math.max(1, Math.min(2_000_000, Math.floor(targetN)));
    const capV = Math.max(2, Math.min(1_000_000_000, Math.floor(valueMax)));
    const capC = Math.max(0, Math.min(2_000_000, Math.floor(countCap)));
    return `#include <bits/stdc++.h>
using namespace std;
static const string SEED = __SEED__;
static const long long TARGET_N = ${capN};
static const long long VALUE_MAX = ${capV};
// 计数变量的题面上界。token 模式下「个数」不一定叫 n（P1048 是 M ≤ 100），
// 这时必须用它把规模夹住，否则会造出超出题面约束的数据。
static const long long COUNT_CAP = ${capC};

int main(int argc, char** argv) {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    const int gid = argc > 1 ? max(1, atoi(argv[1])) : 1;
    unsigned long long st = (unsigned long long)(gid * 131 + 7) * 0x9E3779B97F4A7C15ULL + 0x123456789ULL;
    auto rnd = [&]() -> unsigned long long {
        st ^= st << 13; st ^= st >> 7; st ^= st << 17;
        return st;
    };

    // 读 seed：正常情况 stdin 为空（record.add 不保存 generate 的 input），
    // 所以真正的 seed 是编译进二进制的 SEED 常量。
    string raw;
    { string line; while (getline(cin, line)) { raw += line; raw += '\\n'; } }
    bool blank = true;
    for (char c : raw) if (!isspace((unsigned char)c)) { blank = false; break; }
    if (blank) raw = SEED;

    vector<vector<string>> lines;
    {
        istringstream iss(raw);
        string line;
        while (getline(iss, line)) {
            vector<string> ts;
            istringstream ls(line);
            string t;
            while (ls >> t) ts.push_back(t);
            lines.push_back(ts);
        }
    }
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    if (lines.empty()) { cout << "1\\n"; return 0; }

    auto isInt = [](const string& s) -> bool {
        if (s.empty()) return false;
        size_t i = (s[0] == '-' || s[0] == '+') ? 1 : 0;
        if (i >= s.size()) return false;
        for (; i < s.size(); i++) if (!isdigit((unsigned char)s[i])) return false;
        return true;
    };
    auto toI = [](const string& s) -> long long {
        try { return stoll(s); } catch (...) { return 0; }
    };
    auto isZeroLine = [&](const vector<string>& v) -> bool {
        if (v.empty()) return false;
        for (auto& t : v) { if (!isInt(t) || toI(t) != 0) return false; }
        return true;
    };

    enum { FLAT = 0, SINGLE_NUM = 1, INLINE_ARR = 2, N_LINES = 3, N_TAIL = 4,
           NM_LINES = 5, NM_TAIL = 6, N_THEN_INLINE = 7, NM_COORDS = 8, TOK = 9 };
    int shape = FLAT;
    long long decl = -1, declM = -1;
    int tailIdx = -1;
    const int L = (int)lines.size();

    if (L == 1) {
        const auto& v = lines[0];
        if (v.size() == 1 && isInt(v[0])) { shape = SINGLE_NUM; decl = toI(v[0]); }
        else if (v.size() == 4 && isInt(v[0]) && isInt(v[1]) && isInt(v[2]) && isInt(v[3])) {
            shape = NM_COORDS; decl = toI(v[0]); declM = toI(v[1]);
        } else if (v.size() >= 2 && isInt(v[0]) && (long long)v.size() - 1 == toI(v[0])) {
            shape = INLINE_ARR; decl = toI(v[0]);
        }
    } else {
        int bodyRows = L - 1;
        bool hasTail = false;
        if (bodyRows >= 2) {
            const auto& last = lines[L - 1];
            if (isZeroLine(last) && last.size() == lines[L - 2].size()) hasTail = true;
            else if (last.size() != lines[1].size()) hasTail = true;
        }
        if (hasTail) { bodyRows = L - 2; tailIdx = L - 1; }
        if (lines[0].size() == 1 && isInt(lines[0][0]) && toI(lines[0][0]) == bodyRows) {
            shape = hasTail ? N_TAIL : N_LINES; decl = toI(lines[0][0]);
        } else if (lines[0].size() == 2 && isInt(lines[0][0]) && isInt(lines[0][1])
                   && toI(lines[0][0]) == bodyRows) {
            shape = hasTail ? NM_TAIL : NM_LINES; decl = toI(lines[0][0]); declM = toI(lines[0][1]);
        } else if (L == 3 && lines[0].size() == 1 && isInt(lines[0][0])
                   && lines[1].size() == 1 && isInt(lines[1][0])
                   && (long long)lines[2].size() == toI(lines[1][0])) {
            shape = N_THEN_INLINE; decl = toI(lines[0][0]); declM = toI(lines[1][0]);
        }
    }

    /* ---------------- 方法 A：token 流识别 ----------------
     * 逐行判定在「一个数占一行」「表头与数据同行」等写法下会失败，
     * 这里把 seed 压平成 token 序列（忽略换行），只用「整数个数关系」推断结构：
     *   TOK_VEC1  n, a1..an                (ntok == n+1)
     *   TOK_VEC2  w, n, a1..an             (ntok == n+2)
     *   TOK_MW2   w, n, n*k 个值 (k>=2)     (ntok-2 能被 n 整除)
     *   TOK_MA1   n, w, n*k 个值 (k>=2)     (同上，只是头两个数顺序相反)
     *   TOK_BARE  裸数组（无显式个数）       → 按 target 个元素扩展
     * 数值一律从 seed 对应列的 [min,max] 里取，保证不越过题面隐含的取值范围。
     */
    int tokMode = 0;          // 0=none 1=SINGLE 2=VEC1 3=VEC2 4=MW2 5=MA1 6=BARE
    long long tokCnt = 0;     // seed 里的规模值（第 1 或第 2 个 token）
    long long tokOther = 0;   // 表头里另一个值（容量 w 之类），保持 seed 原值
    int tokCols = 1;          // 每条记录的值个数
    int tokHeader = 0;        // 表头 token 数（0/1/2）
    vector<long long> cmin, cmax;

    vector<vector<int>> tokHeaderLines;   // 表头每行包含哪些 token 下标
    if (shape == FLAT) {
        vector<long long> tk;
        bool allInt = true;
        for (auto& ln : lines) {
            for (auto& t : ln) {
                if (!isInt(t)) { allInt = false; break; }
                tk.push_back(toI(t));
            }
            if (!allInt) break;
        }
        const long long ntok = (long long)tk.size();
        if (allInt && ntok > 0) {
            if (ntok == 1) {
                tokMode = 1; tokHeader = 0; tokCnt = 1; tokCols = 1;
            } else {
                const long long a = tk[0], b = tk[1];
                if (b > 0 && ntok - 1 == b) {
                    tokMode = 2; tokHeader = 1; tokCnt = b; tokCols = 1;
                } else if (b > 0 && ntok - 2 == b) {
                    tokMode = 3; tokHeader = 2; tokCnt = b; tokCols = 1;
                } else if (b > 0 && ntok - 2 > b && (ntok - 2) % b == 0) {
                    tokMode = 4; tokHeader = 2; tokCnt = b; tokCols = (int)((ntok - 2) / b);
                } else if (a > 0 && ntok - 2 > a && (ntok - 2) % a == 0) {
                    tokMode = 5; tokHeader = 2; tokCnt = a; tokCols = (int)((ntok - 2) / a);
                } else {
                    tokMode = 6; tokHeader = 0; tokCnt = ntok; tokCols = 1;
                }
            }
            if (tokMode) {
                shape = TOK;
                tokOther = tokMode == 5 ? tk[1] : (tokHeader == 2 ? tk[0] : 0);
                cmin.assign(tokCols, 0);
                cmax.assign(tokCols, 0);
                bool first = true;
                for (long long i = tokHeader; i < ntok; i++) {
                    int j = (int)((i - tokHeader) % tokCols);
                    if (first) { cmin.assign(tokCols, tk[i]); cmax.assign(tokCols, tk[i]); first = false; }
                    cmin[j] = min(cmin[j], tk[i]);
                    cmax[j] = max(cmax[j], tk[i]);
                }
                if (first) { cmin.assign(tokCols, 1); cmax.assign(tokCols, 2); }
                // 记录表头在 seed 里的原分行方式：P1094 是「100 / 9」两行，
                // P1048 是「70 3」一行。压平后必须按原样还原，否则格式就错了。
                if (tokHeader > 0) {
                    int used = 0;
                    for (auto& ln : lines) {
                        vector<int> ids;
                        for (size_t j = 0; j < ln.size() && used < tokHeader; j++, used++) {
                            ids.push_back(used);
                        }
                        tokHeaderLines.push_back(ids);
                        if (used >= tokHeader) break;
                    }
                }
            }
        }
    }

    const int PROFILE_MIN = 1, PROFILE_ASC = 7, PROFILE_DESC = 8, PROFILE_MAXV = 9;
    // 规模：以题面上界为准，至少不小于 seed 的规模；第 1 组取最小边界
    int cols = 0;
    if (shape == N_LINES || shape == N_TAIL || shape == NM_LINES || shape == NM_TAIL) {
        for (int i = 1; i <= L - 1 - (tailIdx >= 0 ? 1 : 0); i++) cols = max(cols, (int)lines[i].size());
    }
    if (shape == TOK) cols = tokCols;
    long long budget = cols > 0 ? max(1LL, 2000000LL / cols) : 2000000LL;
    long long N = shape == TOK ? tokCnt : (decl > 0 ? decl : 1);
    if (N < 1) N = 1;
    long long target = TARGET_N;
    if (target < 1) target = 1;
    if (target < N) target = N;
    if (target > budget) target = budget;
    if (target > 2000000) target = 2000000;
    if (shape == TOK && COUNT_CAP > 0 && target > COUNT_CAP) target = COUNT_CAP;
    if (target < N) target = N;            // 不能小于 seed 自身规模
    if (gid == PROFILE_MIN) target = max(1LL, min(N, 2LL));

    // 数据体里「看起来像下标」的列：所有值都在 [0, seedN] 内 → 生成时夹到 [1, target]
    vector<char> isIdx(cols, 0), zeroCol(cols, 0);
    if (cols > 0 && (shape == N_LINES || shape == N_TAIL || shape == NM_LINES || shape == NM_TAIL)) {
        int bodyEnd = L - 1 - (tailIdx >= 0 ? 1 : 0);
        for (int j = 0; j < cols; j++) {
            bool ok = true, hasNum = false, hasZero = false;
            for (int i = 1; i <= bodyEnd; i++) {
                if (j >= (int)lines[i].size() || !isInt(lines[i][j])) { ok = false; break; }
                long long v = toI(lines[i][j]);
                if (v < 0 || v > N) { ok = false; break; }
                hasNum = true;
                if (v == 0) hasZero = true;
            }
            if (ok && hasNum) { isIdx[j] = 1; zeroCol[j] = hasZero; }
        }
    }

    // 「首行单个 n + 若干 3 列坐标行 + 全 0 哨兵」是方格类题（如 P1004）：
    // 极限数据应把 n*n 个格子全部填满，而不是只重复样例那几行。
    const bool denseGrid = shape == N_TAIL && tailIdx >= 0 && isZeroLine(lines[tailIdx])
        && lines[0].size() == 1 && cols == 3;

    // TOK 模式专用取值：在 seed 该列的 [min,max] 内随机，保证不越界也不失真
    auto genTokValue = [&](int col, long long row) -> string {
        long long lo = cmin[(size_t)col], hi = cmax[(size_t)col];
        if (hi < lo) swap(lo, hi);
        if (gid == PROFILE_MAXV) return to_string(hi);
        long long spread = hi - lo;
        if (gid == PROFILE_ASC) {
            long long step = max(1LL, spread / max(1LL, target));
            return to_string(min(hi, lo + row * step));
        }
        if (gid == PROFILE_DESC) {
            long long step = max(1LL, spread / max(1LL, target));
            return to_string(max(lo, hi - row * step));
        }
        if (gid == PROFILE_MIN) return to_string(lo);
        if (spread <= 0) return to_string(lo);
        long long v = lo + (long long)(rnd() % (unsigned long long)(spread + 1));
        return to_string(v);
    };

    auto genValue = [&](const string& rawTok, int col, long long row) -> string {
        long long seedV = toI(rawTok);
        if (shape == FLAT) {
            // 结构未知：只随机数值，规模保持样例大小，避免造出非法数据
            long long hi = max(2LL, min(llabs(seedV) * 8 + 10, VALUE_MAX));
            if (seedV == 0) return to_string(rnd() % min(hi, 3LL));
            long long v = 1 + (long long)(rnd() % (unsigned long long)hi);
            return to_string(seedV < 0 ? -v : v);
        }
        if (col < (int)isIdx.size() && isIdx[col]) {
            long long lo = zeroCol[col] ? 0 : 1;
            long long span = max(1LL, target - lo);
            return to_string(lo + (long long)(rnd() % (unsigned long long)(span + 1)));
        }
        if (gid == PROFILE_MAXV) return to_string(VALUE_MAX);
        if (gid == PROFILE_ASC) {
            long long step = max(1LL, VALUE_MAX / max(1LL, target));
            return to_string(min(VALUE_MAX, max(1LL, seedV) + row * step));
        }
        if (gid == PROFILE_DESC) {
            long long step = max(1LL, VALUE_MAX / max(1LL, target));
            long long v = max(0LL, VALUE_MAX - row * step);
            return to_string(seedV < 0 ? -v : v);
        }
        long long hi = max(2LL, min(max(10LL, llabs(seedV) * 8 + 10), VALUE_MAX));
        long long v = 1 + (long long)(rnd() % (unsigned long long)hi);
        return to_string(seedV < 0 ? -v : v);
    };

    ostringstream out;
    long long rowIdx = 0;
    auto emitRow = [&](const vector<string>& row) {
        // 全 0 行是终止标记（如 P1004 的 "0 0 0"），必须原样保留；
        // 随机化会让 std 读不到结束条件，改成靠 EOF 兜底既不合题面格式也不稳。
        const bool zeroRow = isZeroLine(row);
        for (size_t j = 0; j < row.size(); j++) {
            if (j) out << ' ';
            out << (zeroRow ? row[j] : genValue(row[j], (int)j, rowIdx));
        }
        out << '\\n';
        rowIdx++;
    };
    auto emitBody = [&](int from, int to, long long count) {
        if (from > to) return;
        for (long long i = 0; i < count; i++) emitRow(lines[from + (int)(i % (to - from + 1))]);
    };

    switch (shape) {
        case SINGLE_NUM:
            out << target << '\\n';
            break;
        case INLINE_ARR: {
            out << target;
            const size_t nv = lines[0].size() > 1 ? lines[0].size() - 1 : 1;
            for (long long i = 0; i < target; i++) {
                const string& t = lines[0].size() > 1 ? lines[0][1 + (size_t)(i % nv)] : string("1");
                out << ' ' << genValue(t, 0, i);
            }
            out << '\\n';
            break;
        }
        case NM_COORDS: {
            long long n2 = max(1LL, target), m2 = max(1LL, target);
            out << n2 << ' ' << m2 << '\\n';
            long long x = (long long)(rnd() % (unsigned long long)(n2 + 1));
            long long y = (long long)(rnd() % (unsigned long long)(m2 + 1));
            out << min(x, n2) << ' ' << min(y, m2) << '\\n';
            break;
        }
        case N_LINES:
        case N_TAIL:
            out << target << '\\n';
            if (denseGrid) {
                long long cells = target * target;
                if (cells > budget) cells = budget;
                for (long long k = 0; k < cells; k++) {
                    long long x = k / target + 1, y = k % target + 1;
                    out << x << ' ' << y << ' '
                        << genValue(lines[1][2 % max<size_t>(1, lines[1].size())], 2, k) << '\\n';
                }
            } else {
                emitBody(1, L - 1 - (tailIdx >= 0 ? 1 : 0), target);
            }
            if (tailIdx >= 0) emitRow(lines[tailIdx]);
            break;
        case NM_LINES:
        case NM_TAIL: {
            long long M = declM > 0 ? declM : 1;
            out << target << ' ' << M << '\\n';
            emitBody(1, L - 1 - (tailIdx >= 0 ? 1 : 0), target);
            if (tailIdx >= 0) emitRow(lines[tailIdx]);
            break;
        }
        case N_THEN_INLINE: {
            out << target << '\\n' << target << '\\n';
            for (long long i = 0; i < target; i++) {
                if (i) out << ' ';
                out << genValue(lines[2][(int)(i % max<size_t>(1, lines[2].size()))], 0, i);
            }
            out << '\\n';
            break;
        }
        case TOK: {
            // 输出布局 = 「seed 的表头原样（只把规模值换成 target）」+「target 行数据」
            //   表头 token 数 0：无表头（裸数组）
            //   表头 token 数 1：n
            //   表头 token 数 2：w n 或 n w（哪个是规模由 tokMode 决定）
            // 每个数据行输出 tokCols 个值，取值限制在 seed 该列的 [min,max]。
            const long long K = max(1, tokCols);
            auto countTok = [&]() -> int {
                if (tokHeader == 1) return 0;
                if (tokHeader == 2) return (tokMode == 5) ? 0 : 1;   // MA1: n w；其余 w n
                return -1;
            };
            const int cntIdx = countTok();
            if (tokHeader == 0) {
                // 裸数组：一行 target 个值
                for (long long i = 0; i < target; i++) {
                    if (i) out << ' ';
                    out << genTokValue(0, i);
                }
                out << '\\n';
            } else {
                for (auto& ids : tokHeaderLines) {
                    for (size_t j = 0; j < ids.size(); j++) {
                        if (j) out << ' ';
                        int ti = ids[j];
                        if (ti == cntIdx) out << target;
                        else if (ti == 0) out << tokOther;
                        else out << tokCnt;
                    }
                    out << '\\n';
                }
            }
            if (tokMode == 1) break;   // 单个数：没有数据体
            for (long long r = 0; r < target; r++) {
                for (long long j = 0; j < K; j++) {
                    if (j) out << ' ';
                    out << genTokValue((int)(j % K), r);
                }
                out << '\\n';
            }
            break;
        }
        default:
            for (auto& ln : lines) emitRow(ln);
            break;
    }
    cout << out.str();
    return 0;
}
`;
}

function parseTimeMs(raw: any, fallback = 1000): number {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const m = String(raw || '').match(/([\d.]+)\s*(ms|s)/i);
    if (!m) return fallback;
    const n = Number(m[1]);
    return /s/i.test(m[2]) && !/ms/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

function parseMemoryMb(raw: any, fallback = 512): number {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const m = String(raw || '').match(/([\d.]+)\s*(mb|gb|kb|m|g|k)?/i);
    if (!m) return fallback;
    const n = Number(m[1]);
    const unit = String(m[2] || 'mb').toLowerCase();
    if (unit.startsWith('g')) return Math.round(n * 1024);
    if (unit.startsWith('k')) return Math.max(1, Math.round(n / 1024));
    return Math.round(n);
}

/**
 * 判断 seed 的结构能不能放大（与生成器里的 shape 识别保持一致）。
 * 不能放大的题（如 A+B 这种一行两个数）不要触发「升档重跑」，
 * 否则每次 AC 都会白跑两轮 generate。
 */
function seedLooksScalable(seed: string): boolean {
    return lineShapeScalable(seed) || tokenStreamScalable(seed);
}

/** 逐行形状识别（原有逻辑）：识别「表头 + n 行」这类分行清晰的结构 */
export function lineShapeScalable(seed: string): boolean {
    const lines = seed.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    const toks = (i: number) => lines[i].split(/\s+/);
    const isInt = (t: string) => /^-?\d+$/.test(t);
    const allInt = (arr: string[]) => arr.length > 0 && arr.every(isInt);
    if (lines.length === 1) {
        const v = toks(0);
        if (v.length === 1 && isInt(v[0])) return true;                       // SINGLE_NUM
        if (v.length === 4 && allInt(v.slice(0, 2))) return true;             // NM_COORDS
        if (v.length >= 2 && isInt(v[0]) && v.length - 1 === Number(v[0])) return true; // INLINE_ARR
        return false;
    }
    let bodyRows = lines.length - 1;
    const last = toks(lines.length - 1);
    const prev = toks(lines.length - 2);
    const zeroLine = last.length > 0 && last.every((t) => isInt(t) && Number(t) === 0);
    if (bodyRows >= 2 && ((zeroLine && last.length === prev.length) || last.length !== toks(1).length)) {
        bodyRows -= 1;
    }
    const first = toks(0);
    if (first.length === 1 && isInt(first[0]) && Number(first[0]) === bodyRows) return true;  // N_LINES / N_TAIL
    if (first.length === 2 && isInt(first[0]) && isInt(first[1])
        && Number(first[0]) === bodyRows) return true;                                        // NM_LINES / NM_TAIL
    if (lines.length === 3 && first.length === 1 && isInt(first[0])
        && toks(1).length === 1 && isInt(toks(1)[0])
        && toks(2).length === Number(toks(1)[0])) return true;                                // N_THEN_INLINE
    return false;
}

/**
 * token 流判定（与生成器 TOK 分支一一对应）：
 * 只要 seed 全是整数，就一定能按某个 token 模式放大，因此这里只排除
 * 「含非整数」的题（字符串/字符题）。
 */
export function tokenStreamScalable(seed: string): boolean {
    const toks = seed.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return false;
    if (!toks.every((t) => /^-?\d+$/.test(t))) return false;
    const n = toks.length;
    if (n === 1) return true;                                   // SINGLE
    const a = Number(toks[0]);
    const b = Number(toks[1]);
    if (b > 0 && n - 1 === b) return true;                      // VEC1
    if (b > 0 && n - 2 === b) return true;                      // VEC2
    if (b > 0 && n - 2 > b && (n - 2) % b === 0) return true;   // MW2
    if (a > 0 && n - 2 > a && (n - 2) % a === 0) return true;   // MA1
    return true;                                                // BARE
}

async function readStatement(domainId: string, docId: number): Promise<string> {
    try {
        const st = await db.collection('problem.statement').findOne({ domainId, docId, name: 'zh.md' })
            || await db.collection('problem.statement').findOne({ domainId, docId });
        return st?.content || '';
    } catch {
        return '';
    }
}

/**
 * 读 seed 样例。StorageService 是跨进程 proxy，get() 返回的流在 backend 侧
 * for-await 读不到内容（实测返回空），所以从 pdoc.data[].etag（真实路径的 base64）
 * 解出路径直接读。
 */
async function readSeed(
    domainId: string, docId: number, pdoc: any, name: string,
): Promise<string> {
    // 优先从题面 statement 解析官方样例——generate 会覆盖 1.in，但不会改题面。
    // 否则反算一次后就以垃圾输出为 seed 继续迭代，永远修不回来。
    const statement = await readStatement(domainId, docId);
    const m = statement.match(/##\s*样例输入\s*#?1[\s\S]*?```[^\n]*\n([\s\S]*?)\n```/i);
    if (m && m[1].trim()) {
        const text = `${m[1].replace(/\n+$/, '')}\n`;
        logger.info('readSeed from statement for %s/%s: %s', domainId, docId, JSON.stringify(text.slice(0, 80)));
        return text;
    }
    // 兜底：从测试点文件读（可能被反算覆盖）
    try {
        const meta = (pdoc?.data || []).find((f: any) => f.name === name);
        if (!meta?.etag) return '';
        const { readFileSync } = await import('fs');
        return readFileSync(Buffer.from(String(meta.etag), 'base64').toString('utf8'), 'utf8');
    } catch {
        return '';
    }
}

/**
 * 只截取题面的「范围段」再交给模型。
 *
 * 模型训练时看到的就是这一段（提示 / 数据范围 / 说明 / Constraints / Hints），
 * 若喂整篇题面，正文里的坐标、示例数字会混进特征，准确率会掉。
 * 找不到范围标题时退回整篇——宁可多给，也不要空手。
 */
export function statementScope(statement: string): string {
    const md = String(statement || '');
    const marks = ['## 提示', '## 数据范围', '## 说明', '## 约定', '## Constraints', '## Hints', '## Notes', '## Subtasks'];
    let idx = -1;
    for (const m of marks) {
        const i = md.lastIndexOf(m);
        if (i > idx) idx = i;
    }
    // 有的题把范围写在「输入格式」里，没有单独标题；这时退到整篇
    if (idx < 0) return md;
    return md.slice(idx);
}

export interface RegenerateOptions {
    reason?: string;
    force?: boolean;
    /** 规模倍率：在解析出的上界基础上再乘，管理员手动调大用 */
    scale?: number;
    /** 直接指定目标规模（内部自动升降档用） */
    targetN?: number;
    /** 第几次尝试（0 = 第 1 次，1 = 自动降档重试） */
    attempt?: number;
    /** generate 使用的时限比例，默认 0.9（题面限制的 90%） */
    ratio?: number;
}

/**
 * 触发一次样例重算。返回 generate 任务 rid（judge 会把 1.in/1.out… 写回题目）。
 * 同一 hash + 同一目标规模已经重算过则直接返回历史记录，保证样例稳定。
 */
export async function regenerateSamples(
    domainId: string, docId: number, uid: number,
    opts: RegenerateOptions = {},
): Promise<{ rid?: string; skipped?: boolean; message: string; targetN?: number }> {
    const oracle = await getOracle(domainId, docId);
    if (!oracle) return { skipped: true, message: '该题还没有 AC 标程，跳过反算' };

    const pdoc = await ProblemModel.get(domainId, docId);
    if (!pdoc) return { skipped: true, message: '题目不存在' };
    const config: any = pdoc.config && typeof pdoc.config === 'object' ? pdoc.config : {};
    const timeLimitMs = Math.max(200, parseTimeMs(config.time, 1000));
    const memoryMb = Math.max(64, parseMemoryMb(config.memory, 512));
    const ratio = Math.min(1, Math.max(0.2, Number(opts.ratio) || 0.9));
    const genTimeMs = Math.max(300, Math.floor(timeLimitMs * ratio));

    const statement = await readStatement(domainId, docId);
    const limits = parseConstraints(statement);
    const seed = await readSeed(domainId, docId, pdoc, '1.in') || '1 2\n';
    const seedRows = Math.max(1, seed.trim().split('\n').length);
    const scalable = seedLooksScalable(seed);

    /* 目标规模优先级：手工指定 > 模型识别的规模上界 > 规则解析的 n > 按样例行数估的默认值。
     * 模型看的是「提示 / 数据范围 / Constraints」整段，能处理变量名不叫 n 的情况
     * （P1048 的 M≤100、P1003 的 n≤10^4），实测中文覆盖 64.4%、测试集 top-1 96%。
     * 模型的输出必须通过「不小于样例规模」这道检查，否则退回规则。
     */
    const predicted = predictRange(statementScope(statement));
    const seedCountForCheck = Math.max(
        1,
        Number(seed.trim().split(/\s+/).filter(Boolean)[1]) || 0,
        Number(seed.trim().split(/\s+/)[0]) || 0,
    );
    const modelN = predicted.targetN && predicted.targetN >= seedCountForCheck
        ? predicted.targetN
        : null;
    let targetN = Number(opts.targetN) || 0;
    if (!targetN) {
        const base = modelN || limits.n || Math.max(20000, seedRows * 2000);
        targetN = Math.round(base * (Number(opts.scale) > 1 ? Number(opts.scale) : 1));
    }
    logger.info('range model for %s/%s: targetN=%s var=%s conf=%s candidates=%j',
        domainId, docId, predicted.targetN, predicted.variable,
        predicted.confidence.toFixed(4), predicted.candidates);
    targetN = Math.min(2_000_000, Math.max(1, targetN));
    /* 计数变量的上界。
     * token 模式下「个数」不一定叫 n（P1048 是 M ≤ 100，P1003 是 n），
     * 只靠 parsedN 会漏掉，于是 targetN 落到默认 20000 并造出违反题面的数据。
     * 取「不小于 seed 规模的最小上界」：题面里所有被写出的上界它都不超过，
     * 因此绝不产生非法规模；代价是可能落在部分分档（如 P1048 的 M ≤ 10）
     * 而不是满档，这是安全性优先的取舍。
     */
    const tokenOnly = tokenStreamScalable(seed) && !lineShapeScalable(seed);
    let countCap = 0;
    if (!limits.n && limits.bounds.length && tokenOnly) {
        const seedCount = Number(seed.trim().split(/\s+/).filter(Boolean)[1])
            || Number(seed.trim().split(/\s+/)[0]) || 1;
        const legal = limits.bounds.filter((b) => b >= seedCount && b <= 2_000_000);
        // 优先取「不超过 seed 规模 50 倍」的最大上界：计数变量通常不会比样量大两个数量级，
        // 这条能选中满档上界（P1048 的 M ≤ 100）而跳过值域上界（如 10^9）。
        const plausible = legal.filter((b) => b <= Math.max(seedCount * 50, seedCount + 10));
        if (plausible.length) countCap = Math.max(...plausible);
        else if (legal.length) countCap = Math.min(...legal);
        if (countCap > 0) targetN = Math.min(targetN, countCap);
    }
    logger.info('countCap for %s/%s: tokenOnly=%s bounds=%j seedCount=%s => cap=%d targetN=%d',
        domainId, docId, tokenOnly, limits.bounds,
        seed.trim().split(/\s+/)[0], countCap, targetN);

    const variant = `${oracle.hash}:${targetN}`;
    const already = await coll(FIXES).findOne({ variant, status: { $in: ['pending', 'done'] } });
    if (already && !opts.force) {
        return {
            skipped: true,
            message: `这份标程在规模 ${targetN} 已反算过，保持本地样例稳定`,
            rid: already.generateRid,
            targetN,
        };
    }

    const genName = 'luogu_gen.cpp';
    const stdName = 'luogu_std.cpp';
    const genSource = generatorCpp(targetN, limits.valueMax, countCap)
        .replace('__SEED__', () => JSON.stringify(seed));
    await ProblemModel.addTestdata(domainId, docId, genName, Buffer.from(genSource));
    await ProblemModel.addTestdata(domainId, docId, stdName, Buffer.from(oracle.code));

    logger.info(
        'generate seed for %s/%s: targetN=%d valueMax=%d limit=%dms genLimit=%dms bounds=%j seed=%s',
        domainId, docId, targetN, limits.valueMax, timeLimitMs, genTimeMs, limits.bounds,
        JSON.stringify(seed.slice(0, 120)),
    );
    const input = Array.from({ length: 10 }, () => seed);

    const rid = await RecordModel.add(
        domainId, docId, uid, '_', `${genName}\n${stdName}`, false,
        { type: 'generate', input },
    );
    await coll(FIXES).updateOne(
        { variant, domainId, docId },
        {
            $set: {
                domainId, docId, uid, variant, oracleHash: oracle.hash,
                targetN, valueMax: limits.valueMax, parsedN: limits.n, scalable,
                attempt: Number(opts.attempt) || 0,
                ratio, timeLimitMs, timeMs: genTimeMs, memoryMb,
                generateRid: rid.toString(), reason: opts.reason || '',
                status: 'pending', createdAt: Date.now(),
            },
        },
        { upsert: true },
    );
    await RecordModel.judge(
        domainId, rid, 0,
        { time: `${genTimeMs}ms`, memory: `${memoryMb}m` },
        { type: 'generate' },
    );
    return {
        rid: rid.toString(),
        targetN,
        message: `已触发反算：目标规模 ${targetN}，generate 时限 ${genTimeMs}ms（题面 ${timeLimitMs}ms 的 ${Math.round(ratio * 100)}%）`,
    };
}

/**
 * generate 任务终态时收尾：
 *  - 统计成功配对的 .in/.out 数与标程实际耗时；
 *  - 成功 ≥6 组即 done（边界 profile 不合法不会毁掉整批）；
 *  - 一组都没成功 → 降档重试一次；
 *  - 数据已成功但标程耗时远低于时限（<25%）且规模还有空间 → 自动升档再跑一次。
 */
export async function finishFix(generateRid: string, _status: string) {
    const id = String(generateRid);
    const fix = await coll(FIXES).findOne({ generateRid: id });
    if (!fix) return;
    if (fix.status !== 'pending') return;

    const g = await RecordModel.coll.findOne({ _id: new ObjectId(id) });
    const testCases: any[] = (g?.testCases || []).filter((c: any) => Number(c.subtaskId) === 2);
    const maxStdTime = testCases.reduce((m: number, c: any) => Math.max(m, Number(c.time) || 0), 0);
    const maxStdMemory = testCases.reduce((m: number, c: any) => Math.max(m, Number(c.memory) || 0), 0);

    const pdoc = await ProblemModel.get(fix.domainId, fix.docId);
    const names: string[] = (pdoc?.data || []).map((f: any) => String(f.name || ''));
    const outs = new Set(names.filter((n) => /^\d+\.out$/.test(n)).map((n) => n.replace('.out', '')));
    const pairs = names.filter((n) => /^\d+\.in$/.test(n) && outs.has(n.replace('.in', ''))).length;
    const limit = Number(fix.timeLimitMs) || 0;
    const worst = limit ? maxStdTime / limit : 0;

    const stats = {
        maxStdTime, maxStdMemory, pairs, limit, worst,
        finishedAt: Date.now(),
    };

    // 同一题可能同时有多条 pending（手工重触发 / 不同规模），只让最新的一条收尾，
    // 否则多条会各自升档、互相覆盖，最后造出超过题面上界的非法数据。
    const newer = await coll(FIXES).countDocuments({
        domainId: fix.domainId,
        docId: fix.docId,
        status: 'pending',
        createdAt: { $gt: Number(fix.createdAt) || 0 },
    });
    if (newer > 0) {
        await coll(FIXES).updateOne({ generateRid: id }, { $set: { ...stats, status: 'superseded' } });
        return;
    }

    // 规模不够：数据成功但远没碰到时限 → 升一档重试。
    // 上限是题面解析出的 n 上界：超过题面约束的「更大」是非法数据，不能要。
    const parsedN = Number(fix.parsedN) > 0 ? Number(fix.parsedN) : 0;
    const budgetCap = parsedN || 200000;
    if (pairs >= 6 && worst < 0.25 && Number(fix.attempt) === 0
        && fix.scalable === true && Number(fix.targetN) < budgetCap) {
        const bigger = Math.min(budgetCap, Math.max(20000, Math.round(Number(fix.targetN) * 4)));
        await coll(FIXES).updateOne({ generateRid: id }, { $set: { ...stats, status: 'superseded' } });
        logger.info('oracle %s/%s: worst=%s%% -> escalate to %d', fix.domainId, fix.docId,
            (worst * 100).toFixed(3), bigger);
        await regenerateSamples(fix.domainId, fix.docId, fix.uid, {
            force: true, reason: '规模自动升档', attempt: 1, targetN: bigger,
        });
        return;
    }
    if (pairs >= 6 && worst < 0.25 && fix.scalable === false) {
        logger.info('oracle %s/%s: 样例结构无法放大（如 A+B），标程 %sms，该题不会为了碰时限而造垃圾数据',
            fix.domainId, fix.docId, maxStdTime);
    } else if (pairs >= 6 && worst < 0.25 && parsedN > 0 && Number(fix.targetN) >= parsedN) {
        logger.info('oracle %s/%s: 已到题面上界 n<=%d，标程 %sms（%s%% 时限），该题无法通过放大规模更极限',
            fix.domainId, fix.docId, parsedN, maxStdTime, (worst * 100).toFixed(3));
    }

    // 一组都没成：多半是结构识别错了，降一档再试一次
    if (pairs === 0 && Number(fix.attempt) === 0) {
        const smaller = Math.max(1, Math.round(Number(fix.targetN) / 10));
        await coll(FIXES).updateOne({ generateRid: id }, { $set: { ...stats, status: 'superseded' } });
        logger.warn('oracle %s/%s: no group survived, retry at %d', fix.domainId, fix.docId, smaller);
        await regenerateSamples(fix.domainId, fix.docId, fix.uid, {
            force: true, reason: '数据不合法，降档重试', attempt: 1, targetN: smaller, ratio: 0.5,
        });
        return;
    }

    const ok = pairs >= 6;
    await coll(FIXES).updateOne({ generateRid: id }, { $set: { ...stats, status: ok ? 'done' : 'failed' } });
    if (ok) {
        logger.info('oracle %s/%s: done with %d pairs, maxStd=%sms (%s%% of %dms)',
            fix.domainId, fix.docId, pairs, maxStdTime, (worst * 100).toFixed(3), limit);
        return;
    }

    // 反算失败时清理残缺测试点：generate 只写成功组的 .in/.out，
    // 标程 RE 的组会留下「有 .in 没 .out」的残缺数据，必须删掉，否则评测直接 FE。
    const ins = names.filter((n) => /^\d+\.in$/.test(n));
    const orphanIns = ins.filter((n) => !outs.has(n.replace('.in', '')));
    for (const name of orphanIns) {
        await ProblemModel.delTestdata(fix.domainId, fix.docId, name);
    }
    if (orphanIns.length) {
        logger.warn('removed %d orphan .in after failed generate for %s/%s: %s',
            orphanIns.length, fix.domainId, fix.docId, orphanIns.join(','));
    }
}

export async function listFixes(domainId: string, docId: number) {
    return coll(FIXES).find({ domainId, docId }).sort({ createdAt: -1 }).limit(20).toArray();
}

export const oracleCollections = { SUBMISSIONS, ORACLES, FIXES };
