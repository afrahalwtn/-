import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {matchesArabicSearch} from './web/arabic-search.js';
import { PersistentMap, storageDirectory, allocateRecordId, hasStoredKind, createExecutionList, listExecutionLists, type ExecutionLine } from './storage.js';
import { hashPassword, verifyPassword } from './passwords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
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

// Models & In-Memory Storage
interface User {
  id: number;
  username: string;
  full_name: string;
  password: string; // Plain or hashed; checked via string compare or hash
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
if (!hasStoredKind('users') && process.env.NODE_ENV === 'production' &&
   (!process.env.AFRAH_ADMIN_PASSWORD || !process.env.AFRAH_STAFF_PASSWORD)) {
  throw new Error('Set AFRAH_ADMIN_PASSWORD and AFRAH_STAFF_PASSWORD before the first production startup');
}
// Initial Data Seed
const users: Map<number, User> = new PersistentMap<User>('users', new Map([
  [
    1,
    {
      id: 1,
      username: 'admin',
      full_name: 'المسؤول العام',
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


const sessions: Map<string, Session> = new Map();

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
    image_url: p.image_name ? `/api/images/${p.image_name}` : null,
    low_stock: p.quantity <= p.min_quantity,
  };
  if (u.role === 'admin' || u.can_view_purchase) {
    data.purchase_price = p.purchase_price;
  }
  if (u.role === 'admin' || u.can_view_sale) {
    data.sale_price = p.sale_price;
  }
  return data;
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
  if (sess.expires_at <= now || now - sess.last_seen_at > 2 * 3600 * 1000) {
    sessions.delete(hash);
    return null;
  }
  const user = users.get(sess.user_id);
  if (!user || !user.is_active) {
    sessions.delete(hash);
    return null;
  }
  sess.last_seen_at = now;
  return { user, session: sess, rawToken: raw };
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const ctx = getSessionContext(req);
  if (!ctx) {
    res.status(401).json({ detail: 'يلزم تسجيل الدخول' });
    return;
  }
  (req as any).auth = ctx;
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
  res.json({ status: 'ok' });
});

// Auth
app.post(['/api/auth/login','/api/admin/auth/login','/api/staff/auth/login'], (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  const uname = String(username).toLowerCase().trim();
  const u = Array.from(users.values()).find((user) => user.username.toLowerCase() === uname);
  if (!u || !u.is_active || !verifyPassword(String(password),u.password)) {
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  if (req.path==='/api/admin/auth/login' && u.role!=='admin') {
    res.status(403).json({ detail: 'بوابة الإدارة مخصصة للمسؤول فقط' });
    return;
  }
  if (req.path==='/api/staff/auth/login' && u.role!=='staff') {
    res.status(403).json({ detail: 'هذا حساب إدارة، استخدم بوابة الإدارة المنفصلة' });
    return;
  }

  const rawToken = crypto.randomBytes(36).toString('base64url');
  const now = Date.now();
  const sess: Session = {
    token_hash: tokenDigest(rawToken),
    user_id: u.id,
    created_at: now,
    last_seen_at: now,
    expires_at: now + 12 * 3600 * 1000,
  };
  sessions.set(sess.token_hash, sess);

  const csrf = csrfForToken(rawToken);
  const secure = process.env.AFRAH_SECURE_COOKIES === 'true';
  res.cookie('afrah_session', rawToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 3600 * 1000,
  });

  // The optional token is kept in JavaScript memory only (never localStorage).
  // It permits embedded cross-site previews to authorize API requests even
  // when browsers reject the session cookie.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: userDict(u), csrf, access_token: rawToken });
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
    list = list.filter(p => matchesArabicSearch(q, p.name, p.description, p.manufacture));
  }
  list.sort((a, b) => b.id - a.id);
  res.json(list.map((p) => productDict(p, ctx.user)));
});

app.post('/api/products', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const { name, description = '', manufacture = '', quantity = 0, min_quantity = 0, purchase_price = 0, sale_price = 0 } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(422).json({ detail: 'اسم المادة مطلوب' });
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
  if (name !== undefined) p.name = String(name).trim();
  if (description !== undefined) p.description = String(description);
  if (manufacture !== undefined) p.manufacture = String(manufacture);
  if (quantity !== undefined) p.quantity = Math.max(0, Number(quantity) || 0);
  if (min_quantity !== undefined) p.min_quantity = Math.max(0, Number(min_quantity) || 0);
  if (purchase_price !== undefined) p.purchase_price = Math.max(0, Number(purchase_price) || 0);
  if (sale_price !== undefined) p.sale_price = Math.max(0, Number(sale_price) || 0);
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

app.post('/api/products/:id/image', requireAuth, requireCsrf, requireAdmin, upload.single('file'), (req, res) => {
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
  p.image_name = req.file.filename;
  p.updated_at = new Date().toISOString();
  products.set(p.id,p);
  res.json({ image_url: `/api/images/${req.file.filename}` });
});

app.get('/api/images/:filename', requireAuth, (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[0-9a-f]{32}\.(?:webp|png|jpg)$/i.test(filename)) {
    res.status(404).json({ detail: 'الصورة غير موجودة' });
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
  res.json(list.map((u) => userDict(u)));
});

app.post('/api/users', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const { username, full_name, password, can_view_purchase = false, can_view_sale = false } = req.body;
  if (!username || !full_name || !password) {
    res.status(422).json({ detail: 'جميع الحقول مطلوبة' });
    return;
  }
  const uname = String(username).toLowerCase().trim();
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
  res.status(201).json(userDict(u));
});

app.patch('/api/users/:id', requireAuth, requireCsrf, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = users.get(id);
  if (!u || u.role !== 'staff') {
    res.status(404).json({ detail: 'المستخدم غير موجود أو لا يمكن تعديله' });
    return;
  }
  const { full_name, password, can_view_purchase, can_view_sale, is_active } = req.body;
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
  res.json(userDict(u));
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
