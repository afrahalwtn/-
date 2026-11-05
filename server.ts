import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const app = express();

// Ensure data and images directory
const dataDir = path.join(__dirname, 'data');
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

// Initial Data Seed
const users: Map<number, User> = new Map([
  [
    1,
    {
      id: 1,
      username: 'admin',
      full_name: 'المسؤول العام',
      password: 'admin123456',
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
      password: 'staff123456',
      role: 'staff',
      can_view_purchase: false,
      can_view_sale: true,
      is_active: true,
      created_at: new Date().toISOString(),
    },
  ],
]);

const products: Map<number, Product> = new Map([
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
]);

const quotes: Map<number, Quote> = new Map([
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
]);

let nextProductId = 6;
let nextUserId = 3;
let nextQuoteId = 2;

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
    filename: (_req, _file, cb) => {
      const ext = '.webp';
      const name = crypto.randomBytes(16).toString('hex') + ext;
      cb(null, name);
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

function getSessionContext(req: Request): AuthContext | null {
  const raw = req.cookies.afrah_session;
  if (!raw || typeof raw !== 'string' || raw.length > 256) return null;
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
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    return;
  }
  const uname = String(username).toLowerCase().trim();
  const u = Array.from(users.values()).find((user) => user.username.toLowerCase() === uname);
  if (!u || !u.is_active || u.password !== String(password)) {
    res.status(401).json({ detail: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
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

  res.json({ user: userDict(u), csrf });
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
  const raw = req.cookies.afrah_session;
  if (raw) {
    sessions.delete(tokenDigest(raw));
  }
  res.clearCookie('afrah_session', { path: '/' });
  res.json({ ok: true });
});

// Products
app.get('/api/products', requireAuth, (req, res) => {
  const ctx = (req as any).auth as AuthContext;
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = Array.from(products.values());
  if (q) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.manufacture.toLowerCase().includes(q)
    );
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
  const id = nextProductId++;
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
  p.image_name = req.file.filename;
  p.updated_at = new Date().toISOString();
  res.json({ image_url: `/api/images/${req.file.filename}` });
});

app.get('/api/images/:filename', requireAuth, (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[0-9a-f]{32}\.webp$/i.test(filename)) {
    res.status(404).json({ detail: 'الصورة غير موجودة' });
    return;
  }
  const filePath = path.join(imagesDir, filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ detail: 'الصورة غير موجودة' });
    return;
  }
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
  const id = nextUserId++;
  const u: User = {
    id,
    username: uname,
    full_name: String(full_name).trim(),
    password: String(password),
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
    u.password = String(password);
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
  res.json(userDict(u));
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

  const id = nextQuoteId++;
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
app.use('/assets', express.static(path.join(__dirname, 'web', 'assets')));
app.use('/web', express.static(path.join(__dirname, 'web')));

// Home entry
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Fallback for SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// Error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ detail: err.message || 'حدث خطأ في الخادم' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
