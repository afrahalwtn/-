from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from server.main import create_app
from server.models import User
from server.security import hash_password

@pytest.fixture
def setup(tmp_path):
    app = create_app(db_url=f"sqlite:///{tmp_path / 'test.sqlite3'}", data_dir=tmp_path / 'data', cookie_secure=False)
    with app.state.session_factory() as db:
        db.add(User(username='admin', full_name='مدير الشركة', password_hash=hash_password('StrongPassword123!'), role='admin', can_view_purchase=True, can_view_sale=True))
        db.commit()
    with TestClient(app) as c:
        yield c
    app.state.engine.dispose()

def login(c, name='admin', password='StrongPassword123!'):
    r = c.post('/api/auth/login',json={'username':name,'password':password})
    assert r.status_code==200, r.text
    assert 'httponly' in r.headers['set-cookie'].lower()
    assert 'samesite=strict' in r.headers['set-cookie'].lower()
    return r.json()['csrf']

def post(c,path,csrf,data=None,method='post'):
    return getattr(c,method)(path,json=data,headers={'X-CSRF-Token':csrf})

def test_no_default_data_and_security_headers(setup):
    c=setup
    r=c.get('/api/products')
    assert r.status_code==401
    assert r.headers['content-security-policy']
    assert r.headers['cache-control']=='no-store'
    csrf=login(c)
    assert c.get('/api/products').json()==[]
    assert c.get('/api/alerts').json()==[]

def test_purchase_price_protected_by_server_and_revoked_sessions(setup):
    c=setup
    csrf=login(c)
    payload={'name':'أقداح ورقية','description':'سعة 200 مل','manufacture':'العراق','quantity':5,'min_quantity':10,'purchase_price':2000,'sale_price':3000}
    r=post(c,'/api/products',csrf,payload)
    assert r.status_code==201, r.text
    assert r.json()['purchase_price']==2000
    r=post(c,'/api/users',csrf,{'username':'worker','full_name':'موظف المخزن','password':'WorkerSecret123!','can_view_purchase':False,'can_view_sale':True})
    assert r.status_code==201,r.text
    staff_id=r.json()['id']
    with TestClient(c.app) as employee:
        staff_csrf=login(employee,'worker','WorkerSecret123!')
        listed=employee.get('/api/products').json()[0]
        assert 'purchase_price' not in listed
        assert listed['sale_price']==3000
        assert employee.get('/api/users').status_code==403
        assert employee.get('/api/quotes').status_code==403
        assert post(employee,'/api/products',staff_csrf,payload).status_code==403
        assert post(employee,'/api/products/1/stock',staff_csrf,{'quantity':999},method='patch').status_code==403
        assert post(employee,'/api/quotes',staff_csrf,{'items':[{'product_id':1,'quantity':2}]}).status_code==403
        r=post(c,f'/api/users/{staff_id}',csrf,{'can_view_purchase':True},method='patch')
        assert r.status_code==200
        # User's old session invalidated immediately after permissions changed
        assert employee.get('/api/products').status_code==401
        login(employee,'worker','WorkerSecret123!')
        assert employee.get('/api/products').json()[0]['purchase_price']==2000

def test_csrf_origin_validation_and_strict_input(setup):
    c=setup;csrf=login(c)
    p={'name':'رول نايلون','quantity':3,'min_quantity':1,'purchase_price':50,'sale_price':80}
    assert c.post('/api/products',json=p).status_code==403
    assert c.post('/api/products',headers={'Origin':'https://evil.example','X-CSRF-Token':csrf},json=p).status_code==403
    assert post(c,'/api/products',csrf,{**p,'unknown_field':'hacker'}).status_code==422
    assert post(c,'/api/products',csrf,{**p,'quantity':-1}).status_code==422
    assert post(c,'/api/products',csrf,p).status_code==201

def test_stock_alerts_and_quote_snapshot(setup):
    c=setup;csrf=login(c)
    p={'name':'ملاعق بلاستك','description':'قوية','manufacture':'تركيا','quantity':2,'min_quantity':5,'purchase_price':100,'sale_price':250}
    created=post(c,'/api/products',csrf,p).json()
    assert c.get('/api/alerts').json()[0]['product_id']==created['id']
    q=post(c,'/api/quotes',csrf,{'items':[{'product_id':created['id'],'quantity':4}]})
    assert q.status_code==201,q.text
    assert q.json()['total']==1000
    assert q.json()['items'][0]['manufacture']=='تركيا'
    p['sale_price']=999
    assert post(c,f'/api/products/{created["id"]}',csrf,p,method='put').status_code==200
    assert c.get(f'/api/quotes/{q.json()["id"]}').json()['total']==1000
    assert post(c,f'/api/products/{created["id"]}/stock',csrf,{'quantity':12},method='patch').status_code==200
    assert c.get('/api/alerts').json()==[]

def test_image_unauthenticated_and_bad_upload(setup):
    c=setup;csrf=login(c)
    p={'name':'كلاص','quantity':1,'min_quantity':1,'purchase_price':1,'sale_price':2}
    item=post(c,'/api/products',csrf,p).json()
    r=c.post(f'/api/products/{item["id"]}/image',headers={'X-CSRF-Token':csrf},files={'file':('bad.png',b'notanimage','image/png')})
    assert r.status_code==415
    assert c.get('/api/images/../../etc/passwd').status_code in (404,400)
    assert c.get('/api/images/aaaa.webp').status_code==404
    with TestClient(c.app) as anon:
        assert anon.get('/api/images/'+'a'*32+'.webp').status_code==401

def test_throttled_wrong_password(setup):
    c=setup
    for _ in range(5):
        r=c.post('/api/auth/login',json={'username':'admin','password':'bad'})
        assert r.status_code==401
    assert c.post('/api/auth/login',json={'username':'admin','password':'bad'}).status_code==429

def test_uploaded_image_is_reencoded_and_requires_login(setup):
    from io import BytesIO
    from PIL import Image
    c=setup; csrf=login(c)
    p={'name':'صحن بلاستك','quantity':8,'min_quantity':2,'purchase_price':900,'sale_price':1100}
    created=post(c,'/api/products',csrf,p).json()
    stream=BytesIO()
    Image.new('RGB',(80,80),(12,62,124)).save(stream,format='PNG')
    image_upload=c.post(f'/api/products/{created["id"]}/image',headers={'X-CSRF-Token':csrf},files={'file':('x.png',stream.getvalue(),'image/png')})
    assert image_upload.status_code==200, image_upload.text
    url=image_upload.json()['image_url']
    r=c.get(url)
    assert r.status_code==200 and r.headers['content-type'].startswith('image/webp')
    with TestClient(c.app) as anon:
        assert anon.get(url).status_code==401
    product=c.get('/api/products').json()[0]
    assert product['image_url']==url


def test_staff_denied_all_admin_mutations_even_with_valid_token(setup):
    c=setup; csrf=login(c)
    u=post(c,'/api/users',csrf,{'username':'staff2','full_name':'مستخدم ثان','password':'AnotherSecret123!'})
    assert u.status_code==201
    with TestClient(c.app) as worker:
        wcsrf=login(worker,'staff2','AnotherSecret123!')
        assert post(worker,'/api/users',wcsrf,{'username':'hack','full_name':'Hack','password':'SecretLongEnough!'}).status_code==403
        assert post(worker,'/api/users/1',wcsrf,{'can_view_purchase':True},method='patch').status_code==403
        assert post(worker,'/api/products/1/image',wcsrf,{},method='post').status_code in (403,422,404)
