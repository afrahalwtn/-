import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {matchesArabicSearch} from './web/arabic-search.js';
import { PersistentMap, storageDirectory, allocateRecordId, hasStoredKind, createExecutionList, listExecutionLists, recordAccountAudit, listAccountAudit, flushCloudWrites, cloudStorageHealthy, cloudEnabled, PersistentSessionMap, type ExecutionLine } from './storage.js';
import { uploadCloudImage, loadCloudImage } from './cloud.js';
import { hashPassword, verifyPassword } from './passwords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
if (cloudEnabled && process.env.NODE_ENV === 'production' && process.env.AFRAH_SECURE_COOKIES !== 'true') {
  throw new Error('Cloud production requires AFRAH_SECURE_COOKIES=true and HTTPS');
}
const app = express();

// Ensure data and images directory
const dataDir = storageDirectory;
const imagesDir = path.join(dataDir, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Secret for CSRF and sessions
const secretKey = crypto.randomBytes(32);

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function csrfForToken(token: string): string {
  return crypto.createHmac('sha256', secretKey).update('csrf:' + token).digest('hex');
}

// Arabic and Latin usernames; reject spaces, invisible/control characters and emoji.
function normalizeUsername(input:string):string{
  return input.normalize('NFKC').trim().toLocaleLowerCase('ar');
}
function validUsername(value:unknown):value is string{
  if(typeof value!=='string')return false;
  return /^[\p{L}\p{N}_.-]{3,60}$/u.test(normalizeUsername(value));
}
// Persistent sessions have no automatic backend expiry: only explicit revocation
// (admin disables/revokes a user, credentials change, or voluntary logout).
// Browsers cap cookie lifetimes, so refresh the HttpOnly cookie on active use.
const REMEMBER_COOKIE_MS=365*24*60*60*1000;
const NO_AUTO_SESSION_EXPIRY=Number.MAX_SAFE_INTEGER;

// Models & In-Memory Storage
interface User {
  id: number;
  username: string;
  full_name: string;
  password: string; // Persisted salted scrypt hash; no plaintext secrets
  role: 'admin' | 'staff';
  can_view_purchase: boolean;
  can_view_sale: boolean;
  is_active: boolean;
  created_at: string;
}

interface Session {
  token_hash: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

interface Product {
  id: number;
  name: string;
  description: string;
  manufacture: string;
  quantity: number;
  min_quantity: number;
  purchase_price: number;
  sale_price: number;
  image_name: string | null;
  updated_at: string;
  // Optional catalog extensions: existing SQLite items remain compatible.
  item_type?: string;
  category?: string;
  sku?: string;
  unit?: string;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  weight_g?: number | null;
  purchase_price_usd?: number | null;
  retail_price_usd?: number | null;
  wholesale_price_iqd?: number | null;
  wholesale_price_usd?: number | null;
  custom_fields?: { label: string; value: string }[];
}

interface QuoteLine {
  original_product_id: number | null;
  product_name: string;
  description: string;
  manufacture: string;
  quantity: number;
  unit_price: number;
  image_name: string | null;
}

interface Quote {
  id: number;
  created_at: string;
  created_by_id: number;
  items: QuoteLine[];
}

// First-run demo data. In production, provide two strong passwords via environment
// before the first database creation. Do not reset existing stored users on restart.
if (!hasStoredKind('users') && (
    (cloudEnabled && !process.env.AFRAH_ADMIN_PASSWORD) ||
    (!cloudEnabled && process.env.NODE_ENV === 'production' &&
       (!process.env.AFRAH_ADMIN_PASSWORD || !process.env.AFRAH_STAFF_PASSWORD)))) {
  throw new Error(cloudEnabled
    ? 'Set a strong AFRAH_ADMIN_PASSWORD before the first cloud startup'
    : 'Set AFRAH_ADMIN_PASSWORD and AFRAH_STAFF_PASSWORD before the first production startup');
}
// Initial Data Seed
const users: Map<number, User> = new PersistentMap<User>('users', new Map([
  [
    1,
    {
      id: 1,
      username: cloudEnabled ? 'يوسف' : 'admin',
      full_name: cloudEnabled ? 'يوسف' : 'المسؤول العام',
      password: hashPassword(process.env.AFRAH_ADMIN_PASSWORD || 'admin123456'),
      role: 'admin',
      can_view_purchase: true,
      can_view_sale: true,
      is_active: true,
      created_at: new Date().toISOString(),
    },
  ],
  [
    2,
    {
      id: 2,
      username: 'staff',
      full_name: 'أحمد العراقي',
      password: hashPassword(process.env.AFRAH_STAFF_PASSWORD || 'staff123456'),
      role: 'staff',
      can_view_purchase: false,
      can_view_sale: true,
      is_active: true,
      created_at: new Date().toISOString(),
    },
  ],
]));

// Upgrade legacy plaintext accounts stored by old local versions without
// replacing users who have previously chosen their own credentials.
for(const account of users.values()){
  if(typeof account.password==='string' &&
    !account.password.startsWith('scrypt$') && account.password.length>=8){
    account.password=hashPassword(account.password);
    users.set(account.id,account);
  }
}

const products: Map<number, Product> = new PersistentMap<Product>('products', new Map([
  [
    1,
    {
      id: 1,
      name: 'رول نايلون غذائي شفاف 45 سم',
      description: 'رول تغليف طعام وساندويتش عالي المرونة والشفافية مخصص للمطاعم',
      manufacture: 'تركي',
      quantity: 45,
      min_quantity: 10,
      purchase_price: 12000,
      sale_price: 15500,
      image_name: null,
      updated_at: new Date().toISOString(),
    },
  ],
  [
    2,
    {
      id: 2,
      name: 'علب برجر ورقية كرافت عازلة للدهن',
      description: 'علب ورق كرافت مقاومة للزيوت والحرارة، كرتون يحتوي على 500 علبة',
      manufacture: 'إماراتي',
      quantity: 180,
      min_quantity: 50,
      purchase_price: 25000,
      sale_price: 32000,
      image_name: null,
      updated_at: new Date().toISOString(),
    },
  ],
  [
    3,
    {
      id: 3,
      name: 'أكواب كرتون طبقتين 8 أونص للمشروبات الساخنة',
      description: 'أكواب ورقية عازلة للحرارة بدون الحاجة لسليف، كرتون 1000 كوب',
      manufacture: 'عراقي',
      quantity: 8,
      min_quantity: 15,
      purchase_price: 18000,
      sale_price: 23000,
      image_name: null,
      updated_at: new Date().toISOString(),
    },
  ],
  [
    4,
    {
      id: 4,
      name: 'سفر طعام نايلون رول سميك',
      description: 'سفرة نايلون عالية الجودة للمطاعم والمناسبات، قياس كبير',
      manufacture: 'كويتي',
      quantity: 0,
      min_quantity: 10,
      purchase_price: 8500,
      sale_price: 11000,
      image_name: null,
      updated_at: new Date().toISOString(),
    },
  ],
  [
    5,
    {
      id: 5,
      name: 'أكياس ورقية بمقبض كرافت فاخر',
      description: 'أكياس توصيل طعام كرافت بني قوية تتحمل الأوزان الثقيلة',
      manufacture: 'سعودي',
      quantity: 65,
      min_quantity: 20,
      purchase_price: 35000,
      sale_price: 44000,
      image_name: null,
      updated_at: new Date().toISOString(),
    },
  ],
]));

const quotes: Map<number, Quote> = new PersistentMap<Quote>('quotes', new Map([
  [
    1,
    {
      id: 1,
      created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      created_by_id: 1,
      items: [
        {
          original_product_id: 1,
          product_name: 'رول نايلون غذائي شفاف 45 سم',
          description: 'رول تغليف طعام وساندويتش عالي المرونة والشفافية مخصص للمطاعم',
          manufacture: 'تركي',
          quantity: 5,
          unit_price: 15500,
          image_name: null,
        },
        {
          original_product_id: 2,
          product_name: 'علب برجر ورقية كرافت عازلة للدهن',
          description: 'علب ورق كرافت مقاومة للزيوت والحرارة، كرتون يحتوي على 500 علبة',
          manufacture: 'إماراتي',
          quantity: 2,
          unit_price: 32000,
          image_name: null,
        },
      ],
    },
  ],
]));


const sessions: Map<string, Session> = new PersistentSessionMap<Session>();
// One-use, 30-second handoffs between the two same-origin portals.
// The ticket is passed in sessionStorage and deleted before redemption,
// never embedded in an address, URL, query string, or long-term storage.
const handoffs = new Map<string,{userId:number,oldSessionHash:string,expiresAt:number}>();
function createAuthSession(u:User) {
  const rawToken=crypto.randomBytes(36).toString('base64url');
  const now=Date.now();
  sessions.set(tokenDigest(rawToken),{
    token_hash:tokenDigest(rawToken),user_id:u.id,
    created_at:now,last_seen_at:now,expires_at:NO_AUTO_SESSION_EXPIRY,
  });
  return {rawToken,csrf:csrfForToken(rawToken)};
}
function refreshLoginCookie(res:Response,rawToken:string) {
  const secure=process.env.AFRAH_SECURE_COOKIES==='true';
  res.cookie('afrah_session',rawToken,{
    httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:REMEMBER_COOKIE_MS,
  });
}
function sendAuthSession(res:Response,u:User,rawToken:string,csrf:string) {
  refreshLoginCookie(res,rawToken);
  res.setHeader('Cache-Control','no-store');
  res.json({user:userDict(u),csrf,access_token:rawToken});
}
function revokeOtherUserSessions(userId:number,keepHash?:string){
  for(const [hash,sess] of sessions){
    if(sess.user_id===userId && hash!==keepHash)sessions.delete(hash);
  }
}
function terminateUserAccess(userId:number):number {
  let ended=0;
  for(const [hash,sess] of sessions){
    if(sess.user_id===userId){sessions.delete(hash);ended++;}
  }
  // Invalidate pending one-time portal handoffs as well.
  for(const [ticket,item] of handoffs){
    if(item.userId===userId)handoffs.delete(ticket);
  }
  return ended;
}
// Small single-server failure throttle. Never reveals whether a username exists.
const loginFailures=new Map<string,{count:number,until:number}>();
function loginThrottleKey(req:Request):string {
  return String(req.ip||req.socket.remoteAddress||'unknown').slice(0,120);
}
function loginTooFast(key:string):boolean {
  const now=Date.now(),entry=loginFailures.get(key);
  if(!entry)return false;
  if(now>=entry.until){loginFailures.delete(key);return false;}
  return entry.count>=8;
}
function recordLoginFailure(key:string):void {
  const now=Date.now(),entry=loginFailures.get(key);
  if(!entry||now>=entry.until)loginFailures.set(key,{count:1,until:now+15*60*1000});
  else entry.count++;
  if(loginFailures.size>3000){
    for(const [k,v] of loginFailures)if(v.until<=now)loginFailures.delete(k);
  }
}




// Helper functions
function userDict(u: User) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    can_view_purchase: u.role === 'admin' || u.can_view_purchase,
    can_view_sale: u.role === 'admin' || u.can_view_sale,
    is_active: u.is_active,
  };
}

function productDict(p: Product, u: User) {
  const data: Record<string, any> = {
    id: p.id,
    name: p.name,
    description: p.description,
    manufacture: p.manufacture,
    quantity: p.quantity,
    min_quantity: p.min_quantity,
    item_type: p.item_type || '',
    category: p.category || '',
    sku: p.sku || '',
    unit: p.unit || '',
    length_cm: p.length_cm ?? null,
    width_cm: p.width_cm ?? null,
    height_cm: p.height_cm ?? null,
    weight_g: p.weight_g ?? null,
    custom_fields: p.custom_fields || [],
    image_url: p.image_name ? `/api/images/${p.image_name}` : null,
    low_stock: p.quantity <= p.min_quantity,
  };
  // Extra prices follow the exact same server-side authorizations as legacy pricing.
  if (u.role === 'admin' || u.can_view_purchase) {
    data.purchase_price = p.purchase_price;
    data.purchase_price_usd = p.purchase_price_usd ?? null;
  }
  if (u.role === 'admin' || u.can_view_sale) {
    data.sale_price = p.sale_price;
    data.retail_price_usd = p.retail_price_usd ?? null;
    data.wholesale_price_iqd = p.wholesale_price_iqd ?? null;
    data.wholesale_price_usd = p.wholesale_price_usd ?? null;
  }
  return data;
}
// Optional per-item specifications are validated and stored together with each item.
function parseProductExtras(source: Record<string,unknown>): Partial<Product> {
  const extras: Partial<Product> = {};
  const textFields = ['item_type','category','sku','unit'] as const;
  for (const field of textFields) {
    if (!Object.prototype.hasOwnProperty.call(source,field)) continue;
    if (source[field] !== null && typeof source[field] !== 'string') throw Error('صيغة حقل الأيتم غير صالحة');
    const value = String(source[field] ?? '').trim();
    if (value.length > 120) throw Error('قيمة الحقل طويلة جداً');
    extras[field] = value;
  }
  const numberFields = ['length_cm','width_cm','height_cm','weight_g','purchase_price_usd','retail_price_usd','wholesale_price_iqd','wholesale_price_usd'] as const;
  for (const field of numberFields) {
    if (!Object.prototype.hasOwnProperty.call(source,field)) continue;
    const raw=source[field];
    if (raw === '' || raw === null || raw === undefined) { extras[field]=null; continue; }
    if (typeof raw !== 'number' && typeof raw !== 'string') throw Error('يجب إدخال رقم صالح للقياس أو السعر');
    const value=Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1e12) throw Error('القياس أو السعر خارج الحدود المسموحة');
    extras[field]=Math.round(value*100)/100;
  }
  if (Object.prototype.hasOwnProperty.call(source,'custom_fields')) {
    const raw=source.custom_fields;
    if (!Array.isArray(raw) || raw.length>25) throw Error('الحد الأقصى 25 حقلاً إضافياً لكل أيتم');
    const labels=new Set<string>();
    extras.custom_fields=raw.map((entry:any)=>{
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.label !== 'string' || typeof entry.value !== 'string') throw Error('الحقل الإضافي غير صالح');
      const label=entry.label.trim(),value=entry.value.trim();
      if (!label || !value || label.length>80 || value.length>400) throw Error('كل حقل إضافي يحتاج عنواناً وقيمة ضمن الحدود');
      if (labels.has(label.toLocaleLowerCase('ar'))) throw Error('لا تكرر عنوان الحقل الإضافي');
      labels.add(label.toLocaleLowerCase('ar'));
      return {label,value};
    });
  }
  return extras;
}

function quoteDict(q: Quote) {
  return {
    id: q.id,
    date: q.created_at,
    items: q.items.map((r) => ({
      product_name: r.product_name,
      description: r.description,
      manufacture: r.manufacture,
      quantity: r.quantity,
      unit_price: r.unit_price,
      total: r.unit_price * r.quantity,
      image_url: r.image_name ? `/api/images/${r.image_name}` : null,
    })),
    total: q.items.reduce((sum, r) => sum + r.unit_price * r.quantity, 0),
  };
}

// Multer for upload
const upload = multer({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('الملف ليس صورة صالحة'));
    }
  },
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, imagesDir),
    filename: (_req, file, cb) => {
      // Preserve the real media type; renaming JPEG/PNG to .webp broke images.
      const ext = ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'} as Record<string,string>)[file.mimetype];
      if (!ext) return cb(new Error('نوع الصورة غير مدعوم'), '');
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
});

// Middleware
app.use(express.json());
app.use(cookieParser());

// For every state-changing request, report success ONLY AFTER Supabase confirms
// the queued durable write. On error, fail closed instead of replying "saved".
app.use((req,res,next)=>{
  if (cloudEnabled && !cloudStorageHealthy()) {
    res.status(503).json({detail:'الاتصال بالحفظ السحابي متوقف، أعد تشغيل الخادم بعد إصلاح الاتصال'});
    return;
  }
  if (!cloudEnabled || !['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    next();
    return;
  }
  const sendJson=res.json.bind(res);
  (res as any).json=(data:any)=>{
    void flushCloudWrites().then(()=>{
      if (!res.headersSent)sendJson(data);
    }).catch((error:unknown)=>{
      console.error('Supabase cloud save failed:',error instanceof Error?error.message:'unknown');
      if (!res.headersSent) {
        res.status(503);
        sendJson({detail:'تعذر تأكيد الحفظ السحابي؛ لم يتم اعتماد العملية. يرجى التواصل مع الإدارة'});
      }
    });
    return res;
  };
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Auth helper
interface AuthContext {
  user: User;
  session: Session;
  rawToken: string;
}

// Accept an explicit in-memory bearer token for embedded previews where
// third-party cookies are blocked. Existing HttpOnly cookies still work.
function sessionTokenFromRequest(req: Request): string | null {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    return /^[A-Za-z0-9_-]{48}$/.test(token) ? token : null;
  }
  const cookieToken = req.cookies?.afrah_session;
  return typeof cookieToken === 'string' && cookieToken.length <= 256 ? cookieToken : null;
}

function getSessionContext(req: Request): AuthContext | null {
  const raw = sessionTokenFromRequest(req);
  if (!raw) return null;
  const hash = tokenDigest(raw);
  const sess = sessions.get(hash);
  if (!sess) return null;
  const now = Date.now();
  if (sess.expires_at <= now) {
    sessions.delete(hash);
    return null;
  }
  const user = users.get(sess.user_id);
  if (!user || !user.is_active) {
    sessions.delete(hash);
    return null;
  }
  return { user, session: sess, rawToken: raw };
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const ctx = getSessionContext(req);
  if (!ctx) {
    res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
    return;
  }
  (req as any).auth = ctx;
  refreshLoginCookie(res,ctx.rawToken);
  next();
}

function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const ctx = (req as any).auth as AuthContext;
  if (!ctx) {
    res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
    return;
  }
  const token = req.headers['x-csrf-token'];
  const expected = csrfForToken(ctx.rawToken);
  if (!token || token !== expected) {
    res.status(403).json({ detail: 'فشل التحقق من سلامة الطلب' });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const ctx = (req as any).auth as AuthContext;
  if (ctx.user.role !== 'admin') {
    res.status(403).json({ detail: 'هذه العملية للإدارة فقط' });
    return;
  }
  next();
}

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({ status:cloudStorageHealthy()?'ok':'degraded',storage:cloudEnabled?'supabase':'sqlite' });
});

// Auth
app.post(['/api/auth/login','/api/admin/auth/login','/api/staff/auth/login'], (req, res) => {
  const { username, password } = req.body || {};
  const throttleKey=loginThrottleKey(req);
  if(loginTooFast(throttleKey)){
    res.setHeader('Retry-After','900');
    res.status(429).json({detail:'محاولات دخول كثيرة من هذا الجهاز. حاول لاحقاً'});
    return;
  }
  if (!username || !password) {
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  const uname = normalizeUsername(String(username));
  const u = Array.from(users.values()).find((user) => normalizeUsername(user.username) === uname);
  if (!u || !u.is_active || !verifyPassword(String(password),u.password)) {
    recordLoginFailure(throttleKey);
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  if (req.path==='/api/admin/auth/login' && u.role!=='admin') {
    res.status(403).json({ detail: 'بوابة الإدارة مخصصة للمسؤول فقط' });
    return;
  }
  loginFailures.delete(throttleKey);
  const {rawToken,csrf}=createAuthSession(u);
  sendAuthSession(res,u,rawToken,csrf);
});

// Administrator can enter the employee view without knowing an employee password.
// Handoff tickets are random, single-use and tied to a pre-authenticated admin.
app.post('/api/auth/handoff', requireAuth, requireCsrf, requireAdmin, (req,res) => {
  const ctx=(req as any).auth as AuthContext;
  for(const [key,item] of handoffs){
    if(item.expiresAt<Date.now())handoffs.delete(key);
  }
  const ticket=crypto.randomBytes(32).toString('base64url');
  handoffs.set(tokenDigest(ticket),{
    userId:ctx.user.id,
    oldSessionHash:ctx.session.token_hash,
    expiresAt:Date.now()+30000,
  });
  res.setHeader('Cache-Control','no-store');
  res.json({ticket,expires_in_seconds:30});
});
app.post('/api/auth/handoff/exchange', (req,res) => {
  const ticket=req.body?.ticket;
  if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket)){
    res.status(401).json({detail:'رمز الانتقال غير صالح'});
    return;
  }
  const hash=tokenDigest(ticket);
  const entry=handoffs.get(hash);
  handoffs.delete(hash);
  if(!entry||entry.expiresAt<Date.now()||!sessions.has(entry.oldSessionHash)){
    res.status(401).json({detail:'انتهت مهلة الانتقال. سجّل الدخول من جديد'});
    return;
  }
  const user=users.get(entry.userId);
  if(!user||!user.is_active||user.role!=='admin'){
    res.status(403).json({detail:'صلاحية الانتقال للإدارة فقط'});
    return;
  }
  sessions.delete(entry.oldSessionHash);
  const {rawToken,csrf}=createAuthSession(user);
  sendAuthSession(res,user,rawToken,csrf);
});

// Change own username/password. Staff cannot alter other accounts.
app.post('/api/auth/change-credentials',requireAuth,requireCsrf,(req,res)=>{
  const ctx=(req as any).auth as AuthContext;
  const current=req.body?.current_password;
  const desired=req.body?.new_password;
  const username=req.body?.username;
  if(typeof current!=='string'||!verifyPassword(current,ctx.user.password)){
    res.status(403).json({detail:'كلمة المرور الحالية غير صحيحة'});
    return;
  }
  if(username!==undefined){
    if(!validUsername(username)){
      res.status(422).json({detail:'اسم الدخول يجب أن يكون 3–60 حرفاً أو رقماً بالعربي أو الإنجليزي، بدون مسافات'});
      return;
    }
    const normalized=normalizeUsername(username);
    if(Array.from(users.values()).some(u=>u.id!==ctx.user.id&&u.username===normalized)){
      res.status(409).json({detail:'اسم الدخول مستخدم من قبل'});
      return;
    }
  }
  if(desired!==undefined && desired!==''){
    if(typeof desired!=='string'||desired.length<10||desired.length>128){
      res.status(422).json({detail:'كلمة المرور الجديدة يجب أن تكون بين 10 و128 رمزاً'});
      return;
    }
    if(desired===current){
      res.status(422).json({detail:'اختر كلمة مرور جديدة مختلفة'});
      return;
    }
  }
  if(username===undefined && !desired){
    res.status(422).json({detail:'أدخل اسماً جديداً أو كلمة مرور جديدة'});
    return;
  }
  if(username!==undefined)ctx.user.username=normalizeUsername(username);
  if(desired)ctx.user.password=hashPassword(desired);
  users.set(ctx.user.id,ctx.user);
  // Log out other devices after credential change; keep the current session.
  revokeOtherUserSessions(ctx.user.id,ctx.session.token_hash);
  res.json({user:userDict(ctx.user),message:'تم تحديث بيانات الدخول'});
});

// Local owner-assisted recovery is explicitly disabled unless the server operator
// starts it with AFRAH_ENABLE_ADMIN_RECOVERY=1. Nothing is sent by email or to GitHub.
const recoveryEnabled=process.env.AFRAH_ENABLE_ADMIN_RECOVERY==='1';
const recoveryCode=recoveryEnabled?crypto.randomBytes(18).toString('base64url'):null;
let recoveryExpires=Date.now()+10*60*1000;
let recoveryFailures=0;
let recoveryUsed=false;
if(recoveryCode){
  console.info('AFRAH ADMIN RECOVERY (10 minutes, one use): '+recoveryCode);
  console.info('Enter this code in /admin > استعادة دخول الإدارة. Do not share the code.');
}
app.post('/api/admin/recover', (req,res)=>{
  if(!recoveryEnabled||!recoveryCode||recoveryUsed||Date.now()>recoveryExpires){
    res.status(404).json({detail:'الاستعادة غير مفعّلة. شغّل خيار الاستعادة محلياً على خادم الشركة'});
    return;
  }
  if(recoveryFailures>=5){
    res.status(429).json({detail:'انتهت محاولات الاستعادة. أعد تشغيل وضع الاستعادة من الخادم'});
    return;
  }
  const provided=req.body?.recovery_code;
  if(typeof provided!=='string' ||
     !/^[A-Za-z0-9_-]{24}$/.test(provided) ||
     !crypto.timingSafeEqual(Buffer.from(tokenDigest(provided),'hex'),Buffer.from(tokenDigest(recoveryCode),'hex'))){
    recoveryFailures++;
    res.status(403).json({detail:'رمز الاستعادة غير صحيح'});
    return;
  }
  const newUsername=req.body?.username,newPassword=req.body?.new_password;
  if(!validUsername(newUsername)||
     typeof newPassword!=='string'||newPassword.length<10||newPassword.length>128){
    res.status(422).json({detail:'اختر اسم دخول صالحاً وكلمة مرور جديدة من 10 إلى 128 رمزاً'});
    return;
  }
  const admin=Array.from(users.values()).find(u=>u.role==='admin');
  if(!admin){
    res.status(404).json({detail:'لا يوجد حساب إدارة لاستعادته'});
    return;
  }
  const normalized=normalizeUsername(newUsername);
  if(Array.from(users.values()).some(u=>u.id!==admin.id&&u.username===normalized)){
    res.status(409).json({detail:'اسم الدخول مستخدم من حساب آخر'});
    return;
  }
  admin.username=normalized;
  admin.password=hashPassword(newPassword);
  admin.is_active=true;
  users.set(admin.id,admin);
  revokeOtherUserSessions(admin.id);
  recoveryUsed=true;
  recoveryExpires=0;
  const {rawToken,csrf}=createAuthSession(admin);
  sendAuthSession(res,admin,rawToken,csrf);
});

// Admin-only session verification. Does not return any data to a staff session.
app.get('/api/admin/me', requireAuth, requireAdmin, (req, res) => {
  const ctx=(req as any).auth as AuthContext;
  res.json({user:userDict(ctx.user),csrf:csrfForToken(ctx.rawToken)});
});

app.get('/api/me', (req, res) => {
  const ctx = getSessionContext(req);
  if (!ctx) {
    res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
    return;
  }
  refreshLoginCookie(res,ctx.rawToken);
  res.json({ user: userDict(ctx.user), csrf: csrfForToken(ctx.rawToken) });
});

app.post('/api/auth/logout', (req, res) => {
  const raw = sessionTokenFromRequest(req);
  if (raw) {
    sessions.delete(tokenDigest(raw));
  }
  res.clearCookie('afrah_session', { path: '/' });
  res.json({ ok: true });
});

// Products
app.get('/api/products', requireAuth, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0,200) : '';
  let list = Array.from(products.values());
  if (q.trim()) {
    list = list.filter(p => matchesArabicSearch(q, p.name, p.description, p.manufacture, p.item_type, p.category, p.sku, p.unit, ...(p.custom_fields||[]).flatMap(x=>[x.label,x.value])));
  }
  list.sort((a, b) => b.id - a.id);
  res.json(list.map((p) => productDict(p, ctx.user)));
});

app.post('/api/products', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const { name, description = '', manufacture = '', quantity = 0, min_quantity = 0, purchase_price = 0, sale_price = 0 } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(422).json({ detail: 'اسم الأيتم مطلوب' });
    return;
  }
  const id = allocateRecordId('products');
  const p: Product = {
    id,
    name: name.trim(),
    description: String(description || ''),
    manufacture: String(manufacture || ''),
    quantity: Math.max(0, Number(quantity) || 0),
    min_quantity: Math.max(0, Number(min_quantity) || 0),
    purchase_price: Math.max(0, Number(purchase_price) || 0),
    sale_price: Math.max(0, Number(sale_price) || 0),
    image_name: null,
    updated_at: new Date().toISOString(),
  };
  try { Object.assign(p,parseProductExtras(req.body||{})); }
  catch(error){res.status(422).json({detail:(error as Error).message});return;}
  products.set(id, p);
  res.status(201).json(productDict(p, ctx.user));
});

app.put('/api/products/:id', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const id = Number(req.params.id);
  const p = products.get(id);
  if (!p) {
    res.status(404).json({ detail: 'المادة غير موجودة' });
    return;
  }
  const { name, description, manufacture, quantity, min_quantity, purchase_price, sale_price } = req.body;
  let extras:Partial<Product>;
  try { extras=parseProductExtras(req.body||{}); }
  catch(error){res.status(422).json({detail:(error as Error).message});return;}
  if(name !== undefined && (typeof name !== 'string' || !name.trim())){
    res.status(422).json({detail:'اسم الأيتم مطلوب'});return;
  }
  if (name !== undefined) p.name = String(name).trim();
  if (description !== undefined) p.description = String(description);
  if (manufacture !== undefined) p.manufacture = String(manufacture);
  if (quantity !== undefined) p.quantity = Math.max(0, Number(quantity) || 0);
  if (min_quantity !== undefined) p.min_quantity = Math.max(0, Number(min_quantity) || 0);
  if (purchase_price !== undefined) p.purchase_price = Math.max(0, Number(purchase_price) || 0);
  if (sale_price !== undefined) p.sale_price = Math.max(0, Number(sale_price) || 0);
  Object.assign(p,extras);
  p.updated_at = new Date().toISOString();
  products.set(p.id,p);
  res.json(productDict(p, ctx.user));
});

app.patch('/api/products/:id/stock', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const id = Number(req.params.id);
  const p = products.get(id);
  if (!p) {
    res.status(404).json({ detail: 'المادة غير موجودة' });
    return;
  }
  const { quantity } = req.body;
  p.quantity = Math.max(0, Number(quantity) || 0);
  p.updated_at = new Date().toISOString();
  products.set(p.id,p);
  res.json(productDict(p, ctx.user));
});

app.delete('/api/products/:id', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!products.has(id)) {
    res.status(404).json({ detail: 'المادة غير موجودة' });
    return;
  }
  products.delete(id);
  res.json({ ok: true });
});

app.post('/api/products/:id/image', requireAuth, requireCsrf, requireAdmin, upload.single('file'), async (req, res) => {
  const id = Number(req.params.id);
  const p = products.get(id);
  if (!p) {
    res.status(404).json({ detail: 'المادة غير موجودة' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ detail: 'لم يتم إرسال ملف' });
    return;
  }
  // Confirm the file's signature, not just the browser-supplied MIME type.
  const head=Buffer.alloc(16);
  const handle=fs.openSync(req.file.path,'r');
  try {fs.readSync(handle,head,0,16,0);} finally {fs.closeSync(handle);}
  const mime=req.file.mimetype;
  const valid=mime==='image/jpeg'?head[0]===0xff&&head[1]===0xd8&&head[2]===0xff:
    mime==='image/png'?head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    mime==='image/webp'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP':false;
  if (!valid) {
    fs.unlinkSync(req.file.path);
    res.status(422).json({detail:'ملف الصورة غير صالح أو امتداده لا يطابق محتواه'});
    return;
  }
  if (cloudEnabled) {
    try {
      await uploadCloudImage(req.file.filename,req.file.path,mime);
    } catch (error) {
      fs.unlinkSync(req.file.path);
      console.error('Cloud image upload failed:',error instanceof Error?error.message:'unknown');
      res.status(503).json({detail:'فشل حفظ الصورة سحابياً؛ لم يتم تغيير صورة الأيتم'});
      return;
    }
    fs.unlinkSync(req.file.path);
  }
  p.image_name = req.file.filename;
  p.updated_at = new Date().toISOString();
  products.set(p.id,p);
  res.json({ image_url: `/api/images/${req.file.filename}` });
});

app.get('/api/images/:filename', requireAuth, async (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[0-9a-f]{32}\.(?:webp|png|jpg)$/i.test(filename)) {
    res.status(404).json({ detail: 'الصورة غير موجودة' });
    return;
  }
  if (cloudEnabled) {
    try {
      const remote = await loadCloudImage(filename);
      res.setHeader('Cache-Control','private, max-age=300');
      res.type(filename.endsWith('.png')?'image/png':filename.endsWith('.jpg')?'image/jpeg':'image/webp');
      res.send(remote.data);
    } catch (error) {
      res.status(404).json({detail:'الصورة غير موجودة أو تعذّر تحميلها من السحابة'});
    }
    return;
  }
  const filePath = path.join(imagesDir, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ detail: 'الصورة غير موجودة' });
    return;
  }
  res.type(filename.endsWith('.png')?'image/png':filename.endsWith('.jpg')?'image/jpeg':'image/webp');
  res.sendFile(filePath);
});

// Alerts
app.get('/api/alerts', requireAuth, (_req, res) => {
  const list = Array.from(products.values())
    .filter((p) => p.quantity <= p.min_quantity)
    .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));

  res.json(
    list.map((p) => ({
      product_id: p.id,
      name: p.name,
      quantity: p.quantity,
      min_quantity: p.min_quantity,
    }))
  );
});

// Users
app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  const list = Array.from(users.values()).sort((a, b) => a.id - b.id);
  res.json(list.map((u) => ({...userDict(u),active_sessions:Array.from(sessions.values()).filter(sess=>sess.user_id===u.id).length})));
});

app.post('/api/users', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const { username, full_name, password, can_view_purchase = false, can_view_sale = false } = req.body;
  if (!username || !full_name || !password) {
    res.status(422).json({ detail: 'جميع الحقول مطلوبة' });
    return;
  }
  const uname = normalizeUsername(String(username));
  if(!validUsername(username) || typeof password!=='string'||password.length<10||password.length>128){
    res.status(422).json({detail:'اسم الدخول أو كلمة المرور غير صالحة (10 رموز على الأقل)'});
    return;
  }
  const exists = Array.from(users.values()).some((u) => u.username === uname);
  if (exists) {
    res.status(409).json({ detail: 'اسم المستخدم موجود' });
    return;
  }
  const id = allocateRecordId('users');
  const u: User = {
    id,
    username: uname,
    full_name: String(full_name).trim(),
    password: hashPassword(String(password)),
    role: 'staff',
    can_view_purchase: Boolean(can_view_purchase),
    can_view_sale: Boolean(can_view_sale),
    is_active: true,
    created_at: new Date().toISOString(),
  };
  users.set(id, u);
  recordAccountAudit(((req as any).auth as AuthContext).user.id,id,'create',u.username);
  res.status(201).json(userDict(u));
});

app.patch('/api/users/:id', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = users.get(id);
  if (!u || u.role !== 'staff') {
    res.status(404).json({ detail: 'المستخدم غير موجود أو لا يمكن تعديله' });
    return;
  }
  const { username, full_name, password, can_view_purchase, can_view_sale, is_active } = req.body;
  if(username!==undefined){
    if(!validUsername(username)){
      res.status(422).json({detail:'اسم الدخول يجب أن يكون بالعربي أو الإنجليزي، من 3 إلى 60 رمزاً'});
      return;
    }
    const normalized=normalizeUsername(username);
    if(Array.from(users.values()).some(x=>x.id!==u.id&&x.username===normalized)){
      res.status(409).json({detail:'اسم الدخول مستخدم'});
      return;
    }
    u.username=normalized;
  }
  if(password!==undefined && password!==''){
    if(typeof password!=='string'||password.length<10||password.length>128){
      res.status(422).json({detail:'كلمة المرور يجب أن تكون من 10 إلى 128 رمزاً'});
      return;
    }
  }
  if (full_name !== undefined) u.full_name = String(full_name).trim();
  if (password !== undefined && password !== '') {
    u.password = hashPassword(String(password));
    // Invalidate sessions for this user
    for (const [hash, sess] of Array.from(sessions.entries())) {
      if (sess.user_id === u.id) sessions.delete(hash);
    }
  }
  if (can_view_purchase !== undefined) u.can_view_purchase = Boolean(can_view_purchase);
  if (can_view_sale !== undefined) u.can_view_sale = Boolean(can_view_sale);
  if (is_active !== undefined) {
    u.is_active = Boolean(is_active);
    if (!u.is_active) {
      for (const [hash, sess] of Array.from(sessions.entries())) {
        if (sess.user_id === u.id) sessions.delete(hash);
      }
    }
  }
  users.set(u.id,u);
  recordAccountAudit(((req as any).auth as AuthContext).user.id,u.id,'update',u.username);
  res.json(userDict(u));
});

// Destructive account controls are always server-side, manager-only and CSRF protected.
app.get('/api/users/audit',requireAuth,requireAdmin,(_req,res)=>{
  res.json(listAccountAudit(60));
});
app.post('/api/users/:id/revoke-sessions',requireAuth,requireCsrf,requireAdmin,(req,res)=>{
  const id=Number(req.params.id),u=users.get(id);
  if(!Number.isSafeInteger(id)||!u||u.role!=='staff'){
    res.status(404).json({detail:'المستخدم غير موجود أو لا يمكن إنهاء جلساته'});
    return;
  }
  const count=terminateUserAccess(id);
  recordAccountAudit(((req as any).auth as AuthContext).user.id,id,'revoke_sessions',u.username);
  res.json({ok:true,revoked_sessions:count,message:'تم تسجيل خروج المستخدم من جميع الأجهزة'});
});
app.delete('/api/users/:id',requireAuth,requireCsrf,requireAdmin,(req,res)=>{
  const id=Number(req.params.id),u=users.get(id);
  if(!Number.isSafeInteger(id)||!u||u.role!=='staff'){
    res.status(404).json({detail:'لا يمكن حذف هذا الحساب'});
    return;
  }
  const ctx=(req as any).auth as AuthContext;
  const confirmation=req.body?.current_password;
  if(typeof confirmation!=='string'||!verifyPassword(confirmation,ctx.user.password)){
    res.status(403).json({detail:'يجب إدخال كلمة مرور الإدارة الصحيحة لتأكيد الحذف النهائي'});
    return;
  }
  const count=terminateUserAccess(id);
  users.delete(id);
  recordAccountAudit(ctx.user.id,id,'delete',u.username);
  // Retain business execution lists under their historical author ID for auditability.
  res.json({ok:true,revoked_sessions:count,message:'حُذف حساب المستخدم نهائياً مع إبقاء سجلات العمل'});
});

// Execution lists: staff record what they carried out from existing catalogue
// materials. They cannot create products, change inventory, or write price data.
app.get('/api/execution-lists', requireAuth, (req, res) => {
 const ctx=(req as any).auth as AuthContext;
 res.json(listExecutionLists(ctx.user.role==='admin'?null:ctx.user.id));
});
app.post('/api/execution-lists', requireAuth, requireCsrf, (req, res) => {
 const ctx=(req as any).auth as AuthContext;
 if(ctx.user.role!=='staff'){
  res.status(403).json({detail:'إضافة قوائم التنفيذ مخصصة للمستخدم الثاني'});
  return;
 }
 const entries=req.body?.items;
 if(!Array.isArray(entries)||entries.length<1||entries.length>500){
  res.status(422).json({detail:'القائمة يجب أن تحتوي من مادة إلى 500 مادة'});
  return;
 }
 const unique=new Set<number>();
 const lines:ExecutionLine[]=[];
 for(const entry of entries){
  const id=entry?.product_id,quantity=entry?.quantity;
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(quantity)||quantity<1||quantity>100000000||unique.has(id)){
   res.status(422).json({detail:'معرّف المادة أو عددها غير صالح، أو المادة مكررة'});
   return;
  }
  const p=products.get(id);
  if(!p){
   res.status(422).json({detail:'إحدى المواد غير مسجلة في النظام'});
   return;
  }
  unique.add(id);
  lines.push({
   product_id:p.id,
   name:p.name,
   description:p.description,
   manufacture:p.manufacture,
   image_url:p.image_name?'/api/images/'+p.image_name:null,
   quantity,
  });
 }
 const record=createExecutionList(ctx.user.id,lines);
 // This is a historical record only; no inventory deduction occurs.
 res.status(201).json(record);
});

// Quotes
app.get('/api/quotes', requireAuth, requireAdmin, (_req, res) => {
  const list = Array.from(quotes.values()).sort((a, b) => b.id - a.id);
  res.json(list.map((q) => quoteDict(q)));
});

app.get('/api/quotes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const q = quotes.get(id);
  if (!q) {
    res.status(404).json({ detail: 'عرض الأسعار غير موجود' });
    return;
  }
  res.json(quoteDict(q));
});

app.post('/api/quotes', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ detail: 'عرض الأسعار فارغ' });
    return;
  }
  for (const item of items) {
    if (!products.has(item.product_id)) {
      res.status(400).json({ detail: 'إحدى المواد غير موجودة' });
      return;
    }
  }

  const id = allocateRecordId('quotes');
  const q: Quote = {
    id,
    created_at: new Date().toISOString(),
    created_by_id: ctx.user.id,
    items: items.map((item) => {
      const p = products.get(item.product_id)!;
      return {
        original_product_id: p.id,
        product_name: p.name,
        description: p.description,
        manufacture: p.manufacture,
        quantity: Math.max(1, Number(item.quantity) || 1),
        unit_price: p.sale_price,
        image_name: p.image_name,
      };
    }),
  };
  quotes.set(id, q);
  res.status(201).json(quoteDict(q));
});

// Static assets
// Serve the official Tabler open-source CSS from the installed package.
// Only this fixed CSS asset is exposed; never publish node_modules broadly.
// Offline, pinned Tabulator spreadsheet resources. MIT licensed, no public node_modules mount.
app.get('/vendor/tabulator.min.css', (_req, res) => {
  res.type('text/css').sendFile(path.join(__dirname,'node_modules','tabulator-tables','dist','css','tabulator.min.css'));
});
app.get('/vendor/tabulator.min.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname,'node_modules','tabulator-tables','dist','js','tabulator.min.js'));
});
app.get('/vendor/tabler.rtl.min.css', (_req, res) => {
  const cssFile = path.join(__dirname, 'node_modules', '@tabler', 'core', 'dist', 'css', 'tabler.rtl.min.css');
  res.type('text/css').sendFile(cssFile);
});
// Tajawal is packaged locally so the Arabic UI works entirely offline.
app.use('/vendor/tajawal', express.static(path.join(__dirname, 'node_modules', '@fontsource', 'tajawal')));
app.use('/assets', express.static(path.join(__dirname, 'web', 'assets')));
app.use('/web', express.static(path.join(__dirname, 'web')));

// Home entry
// Two distinct SPA entrypoints: / is staff-only, /admin is admin-only.
// The login HTML is public, but sensitive data requires an authenticated admin role.
app.get(['/admin','/admin/'], (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.sendFile(path.join(__dirname,'web','admin.html'));
});

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Fallback for SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/admin/')) return res.redirect(302,'/admin');
  res.sendFile(path.join(__dirname,'web','index.html'));
});

// Error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ detail: err.message || 'حدث خطأ في الخادم' });
});

// Finish initial account/metadata writes BEFORE accepting any requests.
// If cloud storage is unavailable, do not start an unsynchronised server.
void (async ()=>{
  try {
    await flushCloudWrites();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on http://0.0.0.0:${PORT}; storage=${cloudEnabled?'supabase':'sqlite'}`);
    });
  } catch (error) {
    console.error('Cannot start server: cloud data could not be confirmed',error instanceof Error?error.message:'unknown');
    process.exitCode=1;
  }
})();
