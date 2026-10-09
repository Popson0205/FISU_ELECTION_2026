const express=require('express'),multer=require('multer'),crypto=require('crypto'),{Pool}=require('pg');
const app=express(),E=process.env;
const pool=new Pool({connectionString:E.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:3*1024*1024}});
const PASS=E.ADMIN_PASSWORD||'change-me';
const TOKEN=crypto.createHmac('sha256',E.SECRET||PASS).update('fisu-admin').digest('hex');
const auth=(q,s,n)=>(q.headers.cookie||'').includes('fisu='+TOKEN)?n():s.status(401).json({error:'Unauthorized'});
app.use(express.json());app.use(express.static('public'));app.get('/apply',(q,s)=>s.sendFile(__dirname+'/public/apply.html'));app.get('/register',(q,s)=>s.sendFile(__dirname+'/public/register.html'));app.get('/admin',(q,s)=>s.sendFile(__dirname+'/public/admin.html'));

pool.query(`CREATE TABLE IF NOT EXISTS applicants(id SERIAL PRIMARY KEY,ref TEXT UNIQUE,data JSONB NOT NULL,status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS files(applicant_id INT REFERENCES applicants(id) ON DELETE CASCADE,kind TEXT,mime TEXT,name TEXT,data BYTEA,PRIMARY KEY(applicant_id,kind));`).catch(e=>console.error('DB init failed',e));

const POS=(E.POSITIONS||'President,Vice President,General Secretary,Assistant General Secretary,Financial Secretary,Treasurer,Public Relation Officer,Director of Sport,Director of Welfare,Director of Social,Librarian,Chief Whip,Auditor').split(',').map(x=>x.trim());
const PRICES={'President':7000,'Vice President':6000,'General Secretary':5000};
const priceOf=p=>PRICES[p]||4000;
app.get('/api/config',(q,s)=>s.json({bank:E.BANK_NAME||'',accName:E.ACCOUNT_NAME||'',accNo:E.ACCOUNT_NUMBER||'',positions:POS,fees:Object.fromEntries(POS.map(p=>[p,priceOf(p)]))}));

pool.query(`CREATE TABLE IF NOT EXISTS voters(id SERIAL PRIMARY KEY,ref TEXT UNIQUE,phone TEXT UNIQUE,data JSONB NOT NULL,status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS voter_files(voter_id INT REFERENCES voters(id) ON DELETE CASCADE,kind TEXT,mime TEXT,name TEXT,data BYTEA,PRIMARY KEY(voter_id,kind));`).catch(e=>console.error('DB init failed',e));
const FILES=[['passport',1],['admission',1],['lgaProof',1],['receipt',1]];
app.post('/api/apply',up.fields(FILES.map(([name])=>({name,maxCount:1}))),async(q,s)=>{
 try{
  const f=q.files||{},b=q.body;
  for(const k of['fullName','gender','dob','phone','email','address','lga','position','ward','faculty','matricNo','institution','qualification','department','level'])
   if(!b[k]||!b[k].trim())return s.status(400).json({error:'Please fill in all required fields.'});
  if(b.position==='President'&&!['HND','B.Sc.','B.A.','LL.B.','B.Tech.','Equivalent qualification'].includes(b.qualification))return s.status(400).json({error:'The President must hold or be pursuing an HND, B.Sc./B.A. or equivalent.'});
  for(const[k,req]of FILES)if(req&&!f[k])return s.status(400).json({error:'Please upload: '+k.replace(/([A-Z])/g,' $1')+'.'});
  for(const k in f)if(!/^(image\/(jpe?g|png|webp)|application\/pdf)$/.test(f[k][0].mimetype))return s.status(400).json({error:'Only JPG, PNG or PDF files are allowed.'});
  const data={};['fullName','gender','dob','phone','email','address','lga','ward','position','institution','faculty','department','level','qualification','matricNo'].forEach(k=>data[k]=(b[k]||'').trim());
  data.fee=priceOf(b.position);
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

app.post('/api/register',up.fields([{name:'passport',maxCount:1},{name:'lgaProof',maxCount:1},{name:'receipt',maxCount:1}]),async(q,s)=>{
 try{
  const f=q.files||{},b=q.body,T=k=>(b[k]||'').trim(),bad=m=>s.status(400).json({error:m});
  for(const k of['fullName','gender','dob','phone','email','address','lga','ward','residency','category'])if(!T(k))return bad('Please fill in all required fields.');
  if(!/^\S+@\S+\.\S+$/.test(T('email')))return bad('Please enter a valid email address.');
  const phone=T('phone').replace(/[\s-]/g,'');
  if(!/^\+?\d{10,14}$/.test(phone))return bad('Please enter a valid phone number.');
  if(!['Indigene','Non-indigene'].includes(T('residency'))||!['SSS 3 student','Undergraduate','Graduate'].includes(T('category')))return bad('Invalid selection.');
  if(T('residency')==='Non-indigene'&&!(+T('years')>=5))return bad('Non-indigenes must have lived in the town for at least 5 years.');
  const sss=T('category')==='SSS 3 student';
  if(sss?!T('school'):!(T('institution')&&T('course')))return bad(sss?'Please enter the name of your school.':'Please enter your institution and course.');
  if(!f.passport)return bad('Please upload your passport photograph.');
  if(!f.lgaProof)return bad('Please upload your proof of LGA of origin.');
  if(!f.receipt)return bad('Please upload your membership payment receipt.');
  for(const k in f)if(!/^(image\/(jpe?g|png|webp)|application\/pdf)$/.test(f[k][0].mimetype))return bad('Only JPG, PNG or PDF files are allowed.');
  const data={};['fullName','gender','dob','email','address','lga','ward','residency','years','category','school','institution','course'].forEach(k=>data[k]=T(k));data.phone=phone;
  const ref='FISUV-'+crypto.randomBytes(3).toString('hex').toUpperCase();
  const c=await pool.connect();
  try{await c.query('BEGIN');
   const r=await c.query('INSERT INTO voters(ref,phone,data) VALUES($1,$2,$3) RETURNING id',[ref,phone,data]);
   for(const k in f)await c.query('INSERT INTO voter_files VALUES($1,$2,$3,$4,$5)',[r.rows[0].id,k,f[k][0].mimetype,f[k][0].originalname,f[k][0].buffer]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  s.json({ref});
 }catch(e){if(e.code==='23505')return s.status(409).json({error:'This phone number is already registered.'});console.error(e);s.status(500).json({error:'Something went wrong. Please try again.'})}
});
app.get('/api/admin/voters',auth,async(q,s)=>{const r=await pool.query('SELECT id,ref,data,status,created_at FROM voters ORDER BY id DESC');s.json(r.rows)});
app.post('/api/admin/voter-status/:id',auth,async(q,s)=>{await pool.query('UPDATE voters SET status=$1 WHERE id=$2',[q.body.status,q.params.id]);s.json({ok:1})});
app.get('/api/admin/voter-file/:id/:kind',auth,async(q,s)=>{
 const r=await pool.query('SELECT mime,data FROM voter_files WHERE voter_id=$1 AND kind=$2',[q.params.id,q.params.kind]);
 if(!r.rows[0])return s.sendStatus(404);s.type(r.rows[0].mime).send(r.rows[0].data);
});
app.use((e,q,s,n)=>s.status(400).json({error:e.code==='LIMIT_FILE_SIZE'?'Each file must be 3MB or less.':'Upload failed.'}));
app.listen(E.PORT||3000,()=>console.log('FISU forms running'));
