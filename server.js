const express=require('express'),multer=require('multer'),crypto=require('crypto'),{Pool}=require('pg');
const app=express(),E=process.env;
const pool=new Pool({connectionString:E.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:3*1024*1024}});
const PASS=E.ADMIN_PASSWORD||'change-me';
const TOKEN=crypto.createHmac('sha256',E.SECRET||PASS).update('fisu-admin').digest('hex');
const auth=(q,s,n)=>(q.headers.cookie||'').includes('fisu='+TOKEN)?n():s.status(401).json({error:'Unauthorized'});
app.use(express.json());app.use(express.static('public'));app.get('/admin',(q,s)=>s.sendFile(__dirname+'/public/admin.html'));

pool.query(`CREATE TABLE IF NOT EXISTS applicants(id SERIAL PRIMARY KEY,ref TEXT UNIQUE,data JSONB NOT NULL,status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS files(applicant_id INT REFERENCES applicants(id) ON DELETE CASCADE,kind TEXT,mime TEXT,name TEXT,data BYTEA,PRIMARY KEY(applicant_id,kind));`).catch(e=>console.error('DB init failed',e));

app.get('/api/config',(q,s)=>s.json({price:E.FORM_PRICE||'NGN 5,000',bank:E.BANK_NAME||'',accName:E.ACCOUNT_NAME||'',accNo:E.ACCOUNT_NUMBER||'',
 positions:(E.POSITIONS||'President,Vice President,General Secretary,Assistant General Secretary,Financial Secretary,Treasurer,Public Relation Officer,Director of Sport,Director of Welfare,Director of Social,Librarian,Chief Whip,Auditor').split(',').map(x=>x.trim())}));

const FILES=[['passport',1],['admission',1],['lgaProof',0],['receipt',1]];
app.post('/api/apply',up.fields(FILES.map(([name])=>({name,maxCount:1}))),async(q,s)=>{
 try{
  const f=q.files||{},b=q.body;
  for(const k of['fullName','gender','dob','phone','email','address','lga','position','institution','qualification','department','level'])
   if(!b[k]||!b[k].trim())return s.status(400).json({error:'Please fill in all required fields.'});
  if(b.position==='President'&&!['HND','B.Sc.','B.A.','LL.B.','B.Tech.','Equivalent qualification'].includes(b.qualification))return s.status(400).json({error:'The President must hold or be pursuing an HND, B.Sc./B.A. or equivalent.'});
  for(const[k,req]of FILES)if(req&&!f[k])return s.status(400).json({error:'Please upload: '+k.replace(/([A-Z])/g,' $1')+'.'});
  for(const k in f)if(!/^(image\/(jpe?g|png|webp)|application\/pdf)$/.test(f[k][0].mimetype))return s.status(400).json({error:'Only JPG, PNG or PDF files are allowed.'});
  const data={};['fullName','gender','dob','phone','email','address','lga','ward','position','institution','faculty','department','level','qualification','matricNo'].forEach(k=>data[k]=(b[k]||'').trim());
  const ref='FISU-'+crypto.randomBytes(3).toString('hex').toUpperCase();
  const c=await pool.connect();
  try{await c.query('BEGIN');
   const r=await c.query('INSERT INTO applicants(ref,data) VALUES($1,$2) RETURNING id',[ref,data]);
   for(const k in f)await c.query('INSERT INTO files VALUES($1,$2,$3,$4,$5)',[r.rows[0].id,k,f[k][0].mimetype,f[k][0].originalname,f[k][0].buffer]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  s.json({ref});
 }catch(e){console.error(e);s.status(500).json({error:'Something went wrong. Please try again.'})}
});
app.use((e,q,s,n)=>s.status(400).json({error:e.code==='LIMIT_FILE_SIZE'?'Each file must be 3MB or less.':'Upload failed.'}));

app.post('/api/login',(q,s)=>{
 if(q.body.password!==PASS)return s.status(401).json({error:'Wrong password.'});
 s.setHeader('Set-Cookie',`fisu=${TOKEN}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict${E.NODE_ENV==='production'||E.RENDER?'; Secure':''}`);s.json({ok:1});
});
app.get('/api/admin/list',auth,async(q,s)=>{const r=await pool.query('SELECT id,ref,data,status,created_at FROM applicants ORDER BY id DESC');s.json(r.rows)});
app.post('/api/admin/status/:id',auth,async(q,s)=>{await pool.query('UPDATE applicants SET status=$1 WHERE id=$2',[q.body.status,q.params.id]);s.json({ok:1})});
app.get('/api/admin/file/:id/:kind',auth,async(q,s)=>{
 const r=await pool.query('SELECT mime,data FROM files WHERE applicant_id=$1 AND kind=$2',[q.params.id,q.params.kind]);
 if(!r.rows[0])return s.sendStatus(404);s.type(r.rows[0].mime).send(r.rows[0].data);
});
app.listen(E.PORT||3000,()=>console.log('FISU forms running'));
