import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import { gzip } from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {matchesArabicSearch} from './web/arabic-search.js';
import { PersistentMap, storageDirectory, allocateRecordId, hasStoredKind, createExecutionList, listExecutionLists, recordAccountAudit, listAccountAudit, flushCloudWrites, refreshCloudKind, markCloudUnhealthy, cloudStorageHealthy, cloudEnabled, PersistentSessionMap, getAdminResetMarker, storeAdminResetMarker, type ExecutionLine } from './storage.js';
import { uploadCloudImage, loadCloudImage, readCloudSession, readCloudUser, listCloudUsers, removeCloudSession } from './cloud.js';
import { hashPassword, verifyPassword } from './passwords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
if (cloudEnabled && process.env.NODE_ENV === 'production' && process.env.AFRAH_SECURE_COOKIES !== 'true') {
  throw new Error('Cloud production requires AFRAH_SECURE_COOKIES=true and HTTPS');
}
const app = express();
function asyncRoute(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>){
  return (req:Request,res:Response,next:NextFunction)=>{
    void handler(req,res,next).catch((error:unknown)=>{
      // Allocator/network failures must not be presented as confirmed failures
      // of business input or silently become a generic internal-server error.
      if(cloudEnabled && error instanceof Error &&
         (/^Supabase request failed:/.test(error.message)||
          /cloud record ID|Cloud ID|Could not reserve/.test(error.message))){
        markCloudUnhealthy(error);
        next(Object.assign(new Error('Cloud persistence unavailable'),{status:503}));
      }else next(error);
    });
  };
}
app.disable('x-powered-by');
// Only trust an explicitly configured number of known proxy hops. Never trust all.
const trustedProxyHops=Number(process.env.AFRAH_TRUST_PROXY_HOPS||0);
if(!Number.isSafeInteger(trustedProxyHops)||trustedProxyHops<0||trustedProxyHops>2){
  throw Error('AFRAH_TRUST_PROXY_HOPS must be 0, 1 or 2');
}
if(trustedProxyHops>0)app.set('trust proxy',trustedProxyHops);


// Ensure data and images directory
const dataDir = storageDirectory;
const imagesDir = path.join(dataDir, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Domain-separate a CSRF proof from the cryptographically random bearer token.
// Derivation is consistent across multiple app servers without exposing a
// shared signing secret or relaxing the existing CSRF header requirement.
function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
// Revocation on any server makes previously issued tokens fail on every node,
// even if their session rows have not yet been physically removed.
function authGeneration(value:{auth_generation?:number}):number{
  const generation=value.auth_generation;
  return typeof generation==='number'&&Number.isSafeInteger(generation)&&generation>=0?
    generation:0;
}
function rotateAuthGeneration(user:User):void{
  user.auth_generation=Math.max(Date.now(),authGeneration(user)+1);
  delete user.auth_generation_keep_hash;
}

function csrfForToken(token: string): string {
  return crypto.createHmac('sha256',token).update('afrah-csrf-v2').digest('hex');
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
  // Monotonic credential/session generation stored in the shared cloud row.
  auth_generation?: number;
  // Preserve only the current session after a self-service password change.
  auth_generation_keep_hash?: string;
}

interface Session {
  token_hash: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  auth_generation?: number;
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
    auth_generation:authGeneration(u),
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
    // A flood of distinct proxy IPs must not grow process memory forever.
    while(loginFailures.size>4096){
      const oldest=loginFailures.keys().next().value;
      if(oldest===undefined)break;
      loginFailures.delete(oldest);
    }
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
  limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 8, parts: 12, fieldSize: 4096 },
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

// Browser defense in depth: permit the first-party app, protected blob images,
// and official font stylesheets, but prevent injected third-party scripts.
// frame-ancestors remains unset until the embed allowlist is confirmed; this
// preserves the existing Google AI Studio preview without weakening script CSP.
app.use(helmet({
  contentSecurityPolicy:{
    useDefaults:false,
    directives:{
      defaultSrc:["'self'"],
      baseUri:["'self'"],
      objectSrc:["'none'"],
      scriptSrc:["'self'"],
      styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      fontSrc:["'self'","https://fonts.gstatic.com","data:"],
      imgSrc:["'self'","blob:","data:"],
      connectSrc:["'self'"],
      formAction:["'self'"]
    }
  },
  frameguard:false,
  crossOriginEmbedderPolicy:false,
  crossOriginOpenerPolicy:false
}));
app.use('/api',rateLimit({
  windowMs:60_000,limit:1200,standardHeaders:'draft-8',legacyHeaders:false,
  message:{detail:'طلبات كثيرة من الجهاز، حاول بعد دقيقة'},
}));
app.use(['/api/auth/login','/api/admin/auth/login','/api/staff/auth/login','/api/admin/recover'],rateLimit({
  windowMs:15*60_000,limit:25,standardHeaders:'draft-8',legacyHeaders:false,
  skipSuccessfulRequests:true,
  message:{detail:'محاولات دخول كثيرة، حاول لاحقاً'}
}));
app.use(express.json({limit:'256kb'}));
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
        const conflict=error instanceof Error && (
          error.message.startsWith('Supabase record conflict:') ||
          /Supabase request failed: HTTP 409/.test(error.message));
        res.status(conflict?409:503);
        sendJson({detail:conflict?
          'رفض النظام كتابة تعديل قديم لأن البيانات تغيّرت بخادم آخر. أعد تشغيل الخادم لتحديث النسخة قبل إعادة المحاولة.' :
          'تعذر تأكيد الحفظ السحابي؛ لم يتم اعتماد العملية. يرجى التواصل مع الإدارة'});
      }
    });
    return res;
  };
  next();
});

// Serialize business-data requests per server while reconciling the shared
// catalogue. Serializing prevents an in-flight refresh from overwriting a local
// (not yet durable) edit. All data still lives in Supabase, not this lock.
let businessRequestTail:Promise<void>=Promise.resolve();
const BUSINESS_QUEUE_LIMIT=32;
let businessRequestsPending=0;
const businessLastRefresh=new Map<string,number>();
app.use((req,res,next)=>{
  if(!cloudEnabled || !req.path.startsWith('/api/')){next();return;}
  const route=req.path;
  const kind=route.startsWith('/api/users/audit')?'account_audit':
    route.startsWith('/api/users')||route==='/api/auth/change-credentials'?'users':
    route.startsWith('/api/products')||route.startsWith('/api/alerts')?'products':
    route.startsWith('/api/quotes')?'quotes':
    route.startsWith('/api/execution-lists')?'execution_lists':null;
  if(!kind){next();return;}
  // Bound memory and waiting time during slow cloud responses. The caller may
  // retry a GET; write requests must check state before being sent again.
  if(businessRequestsPending>=BUSINESS_QUEUE_LIMIT){
    res.setHeader('Retry-After','2');
    res.status(503).json({detail:'النظام مشغول حالياً، حاول بعد لحظات'});
    return;
  }
  businessRequestsPending++;
  const previous=businessRequestTail;
  let unlock!:()=>void;
  const released=new Promise<void>(resolve=>{unlock=resolve;});
  businessRequestTail=previous.then(()=>released);
  let active=false,closed=false,completed=false,preflight=false;
  const queueTimer=setTimeout(()=>{
    // A queued request must not keep the browser waiting indefinitely.
    // Its turn remains reserved so earlier writes are never overtaken.
    if(!active&&!closed&&!res.headersSent){
      res.setHeader('Retry-After','2');
      res.status(503).json({detail:'ازدحام مؤقت في الطلبات، حاول مرة ثانية'});
    }
  },15_000);
  const release=()=>{
    if(completed)return;
    completed=true;
    clearTimeout(queueTimer);
    businessRequestsPending--;
    unlock();
  };
  res.once('finish',()=>{closed=true;if(active&&!preflight)release();});
  res.once('close',()=>{closed=true;if(active&&!preflight)release();});
  void previous.then(async()=>{
    active=true;preflight=true;
    clearTimeout(queueTimer);
    if(closed||res.destroyed){preflight=false;release();return;}
    try{
      // Authorization MUST precede potentially expensive full-catalogue scans:
      // previously any anonymous request to /api/products could trigger them.
      const ctx=await getSessionContext(req);
      if(closed||res.destroyed){preflight=false;release();return;}
      if(!ctx){
        preflight=false;
        res.status(401).json({detail:'يلزم تسجيل الدخول'});
        return;
      }
      (req as any).auth=ctx;
      if(!cloudStorageHealthy()){
        preflight=false;
        res.status(503).json({detail:'الحفظ السحابي متوقف مؤقتاً'});
        return;
      }
      const minAge=req.method==='GET'&&process.env.NODE_ENV!=='test'?1500:0;
      if(Date.now()-(businessLastRefresh.get(kind)||0)>=minAge){
        await refreshCloudKind(kind as 'users'|'products'|'quotes'|'execution_lists'|'account_audit');
        businessLastRefresh.set(kind,Date.now());
      }
      preflight=false;
      if(closed||res.destroyed){release();return;}
      next();
    }catch(error){
      preflight=false;
      console.error('Cloud catalogue or access check failed:',error instanceof Error?error.message:'unknown');
      if(closed||res.destroyed){release();return;}
      if(!res.headersSent)
        res.status(503).json({detail:'تعذّر الوصول إلى بيانات الشركة من السحابة، لم يتم إجراء أي تعديل'});
      else release();
    }
  }).catch(error=>{release();next(error);});
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

async function getSessionContext(req: Request): Promise<AuthContext|null> {
  const raw = sessionTokenFromRequest(req);
  if (!raw) return null;
  const hash = tokenDigest(raw);
  // The DB is the source of truth when several servers share the same cloud.
  // Never trust an in-memory session or stale staff permissions in cloud mode.
  const sess = (cloudEnabled?await readCloudSession(hash):sessions.get(hash)) as Session|undefined|null;
  if (!sess || sess.token_hash!==hash || !Number.isSafeInteger(sess.user_id) ||
      !Number.isSafeInteger(sess.expires_at)||sess.expires_at<=Date.now()) return null;
  const user = (cloudEnabled?await readCloudUser(sess.user_id):users.get(sess.user_id)) as User|undefined|null;
  if(!user || user.id!==sess.user_id || !user.is_active ||
     (user.role!=='admin'&&user.role!=='staff') ||
     (authGeneration(sess)!==authGeneration(user) &&
      user.auth_generation_keep_hash!==hash)) return null;
  return { user, session:sess, rawToken:raw };
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // Business routes have already verified the shared cloud session before
    // expensive catalogue refreshes. Reuse that same validated context.
    const ctx = ((req as any).auth as AuthContext|undefined) || await getSessionContext(req);
    if (!ctx) {
      res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
      return;
    }
    (req as any).auth = ctx;
    refreshLoginCookie(res,ctx.rawToken);
    next();
  }catch(error){
    console.error('Shared session check failed:',error instanceof Error?error.message:'unknown');
    res.status(503).json({detail:'تعذّر التحقق من الجلسة السحابية، حاول مجدداً لاحقاً'});
  }
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
  if(cloudEnabled&&!cloudStorageHealthy())res.status(503);
  res.json({ status:cloudStorageHealthy()?'ok':'degraded',storage:cloudEnabled?'supabase':'sqlite' });
});

// Auth
app.post(['/api/auth/login','/api/admin/auth/login','/api/staff/auth/login'], asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const throttleKey=loginThrottleKey(req);
  if(loginTooFast(throttleKey)){
    res.setHeader('Retry-After','900');
    res.status(429).json({detail:'محاولات دخول كثيرة من هذا الجهاز. حاول لاحقاً'});
    return;
  }
  if(typeof username!=='string'||username.length>60||!validUsername(username)||
     typeof password!=='string'||password.length<1||password.length>128){
    recordLoginFailure(throttleKey);
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  const uname = normalizeUsername(username);
  let candidates:User[];
  try {
    candidates=cloudEnabled?await listCloudUsers() as unknown as User[]:Array.from(users.values());
  }catch(error){
    console.error('Shared login lookup failed:',error instanceof Error?error.message:'unknown');
    res.status(503).json({detail:'تعذر التحقق من بيانات الدخول السحابية'});
    return;
  }
  const u = candidates.find((user) => normalizeUsername(user.username) === uname);
  if (!u || !u.is_active || !verifyPassword(password,u.password)) {
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
}));

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
  rotateAuthGeneration(ctx.user);
  // This works for sessions created on other app servers too, without
  // accidentally inserting a duplicate session under a different cloud ID.
  ctx.user.auth_generation_keep_hash=ctx.session.token_hash;
  users.set(ctx.user.id,ctx.user);
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
  rotateAuthGeneration(admin);
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

app.get('/api/me', async (req, res) => {
  try {
    const ctx = await getSessionContext(req);
    if (!ctx) {
      res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
      return;
    }
    refreshLoginCookie(res,ctx.rawToken);
    res.json({ user: userDict(ctx.user), csrf: csrfForToken(ctx.rawToken) });
  }catch(error){
    console.error('Shared session verification failed:',error instanceof Error?error.message:'unknown');
    res.status(503).json({detail:'تعذر التحقق من الجلسة السحابية'});
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const raw = sessionTokenFromRequest(req);
  if (raw) {
    const hash=tokenDigest(raw);
    if(cloudEnabled){
      try {await removeCloudSession(hash);}
      catch(error){
        console.error('Shared logout failed:',error instanceof Error?error.message:'unknown');
        res.status(503).json({detail:'تعذر تأكيد تسجيل الخروج سحابياً'});return;
      }
    }else sessions.delete(hash);
  }
  res.clearCookie('afrah_session', { path: '/' });
  res.json({ ok: true });
});

// Validate business values before touching any persisted item. Never silently turn
// malformed numbers, negative stock, Infinity, or fractions into other values.
function stockCount(value:unknown):number|null {
  if ((typeof value!=='string'&&typeof value!=='number')||value==='')return null;
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>=0&&n<=100000000?n:null;
}
function moneyAmount(value:unknown):number|null {
  if ((typeof value!=='string'&&typeof value!=='number')||value==='')return null;
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>1e12)return null;
  const rounded=Math.round(n*100)/100;
  return Number.isSafeInteger(Math.round(n*100))&&Math.abs(n-rounded)<1e-7?rounded:null;
}

// Products
app.get('/api/products', requireAuth, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0,200) : '';
  let list = Array.from(products.values());
  if (q.trim()) {
    list = list.filter(p => matchesArabicSearch(q, p.name, p.description, p.manufacture, p.item_type, p.category, p.sku, p.unit, ...(p.custom_fields||[]).flatMap(x=>[x.label,x.value])));
  }
  list.sort((a, b) => b.id - a.id);
  const visible=list.map(p=>productDict(p,ctx.user));
  // Only the large authenticated catalogue gets async gzip. This reduces
  // download size on mobile without modifying HTML, CSS, fields or ordering.
  const acceptsGzip=/(?:^|,)\s*gzip(?:\s*(?:;|,|$))/i.test(String(req.get('accept-encoding')||''));
  if(!acceptsGzip){res.json(visible);return;}
  const payload=Buffer.from(JSON.stringify(visible));
  if(payload.length<32768){res.json(visible);return;}
  gzip(payload,{level:4},(error,compressed)=>{
    if(res.destroyed||res.headersSent)return;
    if(error){res.json(visible);return;}
    res.vary('Accept-Encoding');
    res.setHeader('Content-Encoding','gzip');
    res.type('json').send(compressed);
  });
});

app.post('/api/products', requireAuth, requireCsrf, requireAdmin, asyncRoute(async (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const { name, description = '', manufacture = '', quantity = 0, min_quantity = 0, purchase_price = 0, sale_price = 0 } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length>200) {
    res.status(422).json({ detail: 'اسم الأيتم مطلوب وبحد أقصى 200 رمز' });
    return;
  }
  if(typeof description!=='string'||description.length>4000||
     typeof manufacture!=='string'||manufacture.length>200){
    res.status(422).json({detail:'وصف الأيتم أو بلد الصنع أطول من الحد المسموح'});return;
  }
  const parsedQuantity=stockCount(quantity),parsedMinQuantity=stockCount(min_quantity);
  const parsedPurchase=moneyAmount(purchase_price),parsedSale=moneyAmount(sale_price);
  if ([parsedQuantity,parsedMinQuantity,parsedPurchase,parsedSale].some(value=>value===null)) {
    res.status(422).json({detail:'أدخل أعداداً صحيحة غير سالبة للكميات وأسعاراً مالية صالحة'});
    return;
  }
  // Invalid optional specs must not reserve an ID or touch cloud metadata.
  let validatedExtras:Partial<Product>;
  try { validatedExtras=parseProductExtras(req.body||{}); }
  catch(error){res.status(422).json({detail:(error as Error).message});return;}
  const id = await allocateRecordId('products');
  const p: Product = {
    id,
    name: name.trim(),
    description: String(description || ''),
    manufacture: String(manufacture || ''),
    quantity: parsedQuantity!,
    min_quantity: parsedMinQuantity!,
    purchase_price: parsedPurchase!,
    sale_price: parsedSale!,
    image_name: null,
    updated_at: new Date().toISOString(),
  };
  Object.assign(p,validatedExtras);
  products.set(id, p);
  res.status(201).json(productDict(p, ctx.user));
}));

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
  if(name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length>200)){
    res.status(422).json({detail:'اسم الأيتم مطلوب وبحد أقصى 200 رمز'});return;
  }
  if((description!==undefined&&(typeof description!=='string'||description.length>4000))||
     (manufacture!==undefined&&(typeof manufacture!=='string'||manufacture.length>200))){
    res.status(422).json({detail:'وصف الأيتم أو بلد الصنع أطول من الحد المسموح'});return;
  }
  const parsedQuantity=quantity===undefined?undefined:stockCount(quantity);
  const parsedMinQuantity=min_quantity===undefined?undefined:stockCount(min_quantity);
  const parsedPurchase=purchase_price===undefined?undefined:moneyAmount(purchase_price);
  const parsedSale=sale_price===undefined?undefined:moneyAmount(sale_price);
  if([parsedQuantity,parsedMinQuantity,parsedPurchase,parsedSale].some(value=>value===null)){
    res.status(422).json({detail:'أدخل أعداداً صحيحة غير سالبة للكميات وأسعاراً مالية صالحة'});return;
  }
  const next:Product={...p};
  if (name !== undefined) next.name = String(name).trim();
  if (description !== undefined) next.description = String(description);
  if (manufacture !== undefined) next.manufacture = String(manufacture);
  if (parsedQuantity !== undefined) next.quantity = parsedQuantity!;
  if (parsedMinQuantity !== undefined) next.min_quantity = parsedMinQuantity!;
  if (parsedPurchase !== undefined) next.purchase_price = parsedPurchase!;
  if (parsedSale !== undefined) next.sale_price = parsedSale!;
  Object.assign(next,extras);
  next.updated_at = new Date().toISOString();
  products.set(next.id,next);
  res.json(productDict(next, ctx.user));
});

app.patch('/api/products/:id/stock', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const id = Number(req.params.id);
  const p = products.get(id);
  if (!p) {
    res.status(404).json({ detail: 'المادة غير موجودة' });
    return;
  }
  const parsed=stockCount(req.body?.quantity);
  if(parsed===null){
    res.status(422).json({detail:'العدد يجب أن يكون صحيحاً بين صفر ومئة مليون'});
    return;
  }
  const next:Product={...p,quantity:parsed,updated_at:new Date().toISOString()};
  products.set(next.id,next);
  res.json(productDict(next, ctx.user));
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

app.post('/api/products/:id/image', requireAuth, requireCsrf, requireAdmin, upload.single('file'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const p = products.get(id);
  if (!p) {
    // Multer has already written the upload before the route checks the ID.
    // Remove that temporary file when the item no longer exists.
    if(req.file?.path) {
      try {fs.unlinkSync(req.file.path);}catch(error){console.error('Upload cleanup failed');}
    }
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
  const next:Product={...p,image_name:req.file.filename,updated_at:new Date().toISOString()};
  products.set(next.id,next);
  res.json({ image_url: `/api/images/${req.file.filename}` });
}));

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

app.post('/api/users', requireAuth, requireCsrf, requireAdmin, asyncRoute(async (req, res) => {
  const { username, full_name, password, can_view_purchase = false, can_view_sale = false } = req.body;
  if (!username || !full_name || !password) {
    res.status(422).json({ detail: 'جميع الحقول مطلوبة' });
    return;
  }
  if(typeof full_name!=='string'||!full_name.trim()||full_name.length>120){
    res.status(422).json({detail:'الاسم الكامل يجب أن يكون من 1 إلى 120 رمزاً'});return;
  }
  const uname = normalizeUsername(String(username));
  if(!validUsername(username) || typeof password!=='string'||password.length<10||password.length>128){
    res.status(422).json({detail:'اسم الدخول أو كلمة المرور غير صالحة (10 رموز على الأقل)'});
    return;
  }
  if(typeof can_view_purchase!=='boolean'||typeof can_view_sale!=='boolean'){
    res.status(422).json({detail:'صلاحيات الأسعار يجب أن تكون قيماً صحيحة'});return;
  }
  const exists = Array.from(users.values()).some((u) => u.username === uname);
  if (exists) {
    res.status(409).json({ detail: 'اسم المستخدم موجود' });
    return;
  }
  const id = await allocateRecordId('users');
  const u: User = {
    id,
    username: uname,
    full_name: String(full_name).trim(),
    password: hashPassword(String(password)),
    role: 'staff',
    can_view_purchase,
    can_view_sale,
    is_active: true,
    created_at: new Date().toISOString(),
  };
  users.set(id, u);
  recordAccountAudit(((req as any).auth as AuthContext).user.id,id,'create',u.username);
  res.status(201).json(userDict(u));
}));

app.patch('/api/users/:id', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const current = users.get(id);
  if (!current || current.role !== 'staff') {
    res.status(404).json({ detail: 'المستخدم غير موجود أو لا يمكن تعديله' });
    return;
  }
  // Validate the *entire* edit before touching the original Map entry.
  // A rejected password/display-name must never leave a partial username change.
  const { username, full_name, password, can_view_purchase, can_view_sale, is_active } = req.body || {};
  let nextUsername: string | undefined;
  if (username !== undefined) {
    if (!validUsername(username)) {
      res.status(422).json({detail:'اسم الدخول يجب أن يكون بالعربي أو الإنجليزي، من 3 إلى 60 رمزاً'});
      return;
    }
    nextUsername=normalizeUsername(username);
    if(Array.from(users.values()).some(x=>x.id!==current.id&&x.username===nextUsername)){
      res.status(409).json({detail:'اسم الدخول مستخدم'});
      return;
    }
  }
  const changingPassword=password !== undefined && password !== '';
  if(changingPassword && (typeof password!=='string'||password.length<10||password.length>128)){
    res.status(422).json({detail:'كلمة المرور يجب أن تكون من 10 إلى 128 رمزاً'});
    return;
  }
  if(full_name !== undefined &&
     (typeof full_name!=='string'||!full_name.trim()||full_name.length>120)){
    res.status(422).json({detail:'الاسم الكامل يجب أن يكون من 1 إلى 120 رمزاً'});
    return;
  }
  if((can_view_purchase!==undefined&&typeof can_view_purchase!=='boolean')||
     (can_view_sale!==undefined&&typeof can_view_sale!=='boolean')||
     (is_active!==undefined&&typeof is_active!=='boolean')){
    res.status(422).json({detail:'صلاحيات الموظف وحالة الحساب يجب أن تكون صحيحة'});
    return;
  }
  const next:User={...current};
  if(nextUsername!==undefined)next.username=nextUsername;
  if(full_name!==undefined)next.full_name=full_name.trim();
  if(changingPassword)next.password=hashPassword(password);
  if(can_view_purchase!==undefined)next.can_view_purchase=can_view_purchase;
  if(can_view_sale!==undefined)next.can_view_sale=can_view_sale;
  if(is_active!==undefined)next.is_active=is_active;
  if(changingPassword || is_active===false)rotateAuthGeneration(next);
  users.set(next.id,next);
  // Session invalidation follows the accepted account update. Generation
  // revocation also covers sessions issued by other cloud app instances.
  if(changingPassword || is_active===false)terminateUserAccess(next.id);
  recordAccountAudit(((req as any).auth as AuthContext).user.id,next.id,'update',next.username);
  res.json(userDict(next));
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
  rotateAuthGeneration(u);
  users.set(u.id,u);
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
app.post('/api/execution-lists', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
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
 const record=await createExecutionList(ctx.user.id,lines);
 // This is a historical record only; no inventory deduction occurs.
 res.status(201).json(record);
}));

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

app.post('/api/quotes', requireAuth, requireCsrf, requireAdmin, asyncRoute(async (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length<1 || items.length>500) {
    res.status(422).json({detail:'عرض الأسعار يحتاج من 1 إلى 500 ايتم'});
    return;
  }
  const validated:Array<{product:Product;quantity:number}>=[];
  const seen=new Set<number>();
  let totalCents=0;
  for (const item of items) {
    const productId=item?.product_id;
    const quantity=stockCount(item?.quantity);
    if (!Number.isSafeInteger(productId)||productId<1||seen.has(productId)){
      res.status(422).json({detail:'معرّف الايتم غير صالح أو مكرر'});return;
    }
    const product=products.get(productId);
    if(!product || quantity===null || quantity<1){
      res.status(422).json({detail:'ايتم غير موجود أو عدد غير صالح'});return;
    }
    const cents=Math.round(product.sale_price*100);
    const lineCents=cents*quantity;
    if(!Number.isSafeInteger(cents)||cents<0||!Number.isSafeInteger(lineCents)||
       !Number.isSafeInteger(totalCents+lineCents)){
      res.status(422).json({detail:'مجموع عرض الأسعار تجاوز الحد المالي الآمن'});return;
    }
    totalCents+=lineCents;
    seen.add(productId);
    validated.push({product,quantity});
  }

  const id = await allocateRecordId('quotes');
  const q: Quote = {
    id,
    created_at: new Date().toISOString(),
    created_by_id: ctx.user.id,
    items: validated.map(({product:p,quantity}) => ({
      original_product_id: p.id,
      product_name: p.name,
      description: p.description,
      manufacture: p.manufacture,
      quantity,
      unit_price: p.sale_price,
      image_name: p.image_name,
    })),
  };
  quotes.set(id, q);
  res.status(201).json(quoteDict(q));
}));

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
  // Do not leak stack traces, filesystem locations or Supabase details to clients.
  const code=err?.code;
  const uploadError=err instanceof multer.MulterError;
  const invalidImage=err?.message==='الملف ليس صورة صالحة';
  const status=uploadError?(code==='LIMIT_FILE_SIZE'?413:422):
    invalidImage?422:(err?.type==='entity.too.large'?413:
    (Number.isInteger(err?.status)&&err.status>=400&&err.status<600?err.status:500));
  console.error('Request failed:',{status,code:typeof code==='string'?code:'unknown',
    message:err instanceof Error?err.message:'unknown'});
  if(res.headersSent)return;
  const detail=status===413?'حجم البيانات أو الصورة أكبر من المسموح':
    status===422?'الملف أو البيانات المرسلة غير صالحة':
    status===400?'صيغة الطلب غير صحيحة':
    status===503?'تعذر الاتصال بالحفظ السحابي؛ لم يتم اعتماد العملية':
    status===500?'حدث خطأ داخلي؛ يرجى إعادة المحاولة أو التواصل مع الإدارة':
    'تعذر تنفيذ الطلب';
  res.status(status).json({detail});
});

// One-time owner-assisted reset for existing cloud administrator accounts.
// Only the server operator who controls environment secrets can trigger this.
// Changing AFRAH_ADMIN_PASSWORD alone intentionally never overwrites an account.
function applyOwnerAdminPasswordReset():void {
  const desired=process.env.AFRAH_ADMIN_RESET_PASSWORD;
  if(!desired)return;
  if(!cloudEnabled)throw Error('Owner cloud reset requires Supabase storage');
  if(desired.length<12||desired.length>128||
     !/[A-Za-z\p{L}]/u.test(desired)||!/[0-9\p{N}]/u.test(desired)){
    throw Error('AFRAH_ADMIN_RESET_PASSWORD must be 12-128 characters with letters and numbers');
  }
  const alreadyUsed=getAdminResetMarker();
  if(alreadyUsed&&verifyPassword(desired,alreadyUsed))return;
  const admin=Array.from(users.values()).find(user=>user.role==='admin'&&user.is_active);
  if(!admin)throw Error('Active administrator missing; owner reset was not applied');
  if(!verifyPassword(desired,admin.password)){
    // Never mutate the stored object in place until its replacement is ready.
    const next={...admin,password:hashPassword(desired)};
    rotateAuthGeneration(next);
    users.set(admin.id,next);
    revokeOtherUserSessions(admin.id);
  }
  storeAdminResetMarker(hashPassword(desired));
  recordAccountAudit(admin.id,admin.id,'owner_password_reset','server-controlled recovery');
  console.info('Owner administrator password recovery applied. Remove AFRAH_ADMIN_RESET_PASSWORD from Secrets.');
}

// Finish initial account/metadata writes BEFORE accepting any requests.
// If cloud storage is unavailable, do not start an unsynchronised server.
void (async ()=>{
  try {
    applyOwnerAdminPasswordReset();
    await flushCloudWrites();
    const server=app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on http://0.0.0.0:${PORT}; storage=${cloudEnabled?'supabase':'sqlite'}`);
    });
    server.headersTimeout=30_000;
    server.requestTimeout=180_000;
    server.keepAliveTimeout=5_000;
    server.maxRequestsPerSocket=1000;
    // Render deployments send SIGTERM. Drain accepted requests and confirm
    // queued Supabase writes before allowing the process to exit. A hard
    // deadline prevents hanging forever if the network has disappeared.
    let shuttingDown=false;
    const shutdown=(signal:string)=>{
      if(shuttingDown)return;
      shuttingDown=true;
      console.info('Graceful server shutdown requested:',signal);
      const deadline=setTimeout(()=>{
        console.error('Shutdown deadline exceeded; terminating the process');
        process.exit(1);
      },25_000);
      void new Promise<void>((resolve,reject)=>{
        server.close(error=>error?reject(error):resolve());
        server.closeIdleConnections?.();
      }).then(async()=>{
        await flushCloudWrites();
        clearTimeout(deadline);
        process.exit(0);
      }).catch((error:unknown)=>{
        clearTimeout(deadline);
        console.error('Shutdown could not confirm pending cloud writes:',error instanceof Error?error.message:'unknown');
        process.exit(1);
      });
    };
    process.once('SIGTERM',()=>shutdown('SIGTERM'));
    process.once('SIGINT',()=>shutdown('SIGINT'));
  } catch (error) {
    console.error('Cannot start server: cloud data could not be confirmed',error instanceof Error?error.message:'unknown');
    process.exitCode=1;
  }
})();
