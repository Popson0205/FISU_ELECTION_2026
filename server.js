const express=require('express'),multer=require('multer'),crypto=require('crypto'),{Pool}=require('pg');
const app=express(),E=process.env;
const pool=new Pool({connectionString:E.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:3*1024*1024}});
const PASS=E.ADMIN_PASSWORD||'change-me';
const TOKEN=crypto.createHmac('sha256',E.SECRET||PASS).update('fisu-admin').digest('hex');
const auth=(q,s,n)=>(q.headers.cookie||'').includes('fisu='+TOKEN)?n():s.status(401).json({error:'Unauthorized'});
const esc=t=>String(t).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const mailHtml=t=>`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><div style="background:#4a2410;color:#fff;padding:14px 18px;font-weight:bold">Federation of Ido-Osun Students' Union</div><div style="padding:18px;white-space:pre-wrap;line-height:1.55;color:#2a1a10">${esc(t)}</div><div style="padding:10px 18px;font-size:12px;color:#8a7662">Powered by GeoEstate NIG Limited</div></div>`;
async function sendMail(to,name,subject,text){
 if(!E.BREVO_API_KEY||!E.MAIL_FROM)return{sent:false,error:'Email is not set up yet (BREVO_API_KEY and MAIL_FROM are missing).'};
 try{
  const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':E.BREVO_API_KEY.trim(),'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify({sender:{name:E.MAIL_FROM_NAME||'FISU Electoral Committee',email:E.MAIL_FROM},...(E.REPLY_TO?{replyTo:{email:E.REPLY_TO}}:{}),to:[{email:to,name}],subject,textContent:text,htmlContent:mailHtml(text)})});
  if(!r.ok){const t=await r.text();console.error('Mail error',r.status,t);let m=t;try{m=JSON.parse(t).message||t}catch{}return{sent:false,error:'Brevo said ('+r.status+'): '+String(m).slice(0,200)}}
  return{sent:true};
 }catch(e){console.error(e);return{sent:false,error:e.message}}
}
app.use(express.json());app.use(express.static('public'));app.get('/apply',(q,s)=>s.sendFile(__dirname+'/public/apply.html'));app.get('/register',(q,s)=>s.sendFile(__dirname+'/public/register.html'));app.get('/admin',(q,s)=>s.sendFile(__dirname+'/public/admin.html'));

pool.query(`CREATE TABLE IF NOT EXISTS applicants(id SERIAL PRIMARY KEY,ref TEXT UNIQUE,data JSONB NOT NULL,status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS files(applicant_id INT REFERENCES applicants(id) ON DELETE CASCADE,kind TEXT,mime TEXT,name TEXT,data BYTEA,PRIMARY KEY(applicant_id,kind));`).catch(e=>console.error('DB init failed',e));

const WIN={apply:{name:'application portal',open:E.APPLY_OPEN||'2026-10-14T00:00:00+01:00',close:E.APPLY_CLOSE||'2026-11-15T23:59:59+01:00'},
 voters:{name:'voters registration portal',open:E.VOTE_OPEN||'2026-10-19T00:00:00+01:00',close:E.VOTE_CLOSE||'2026-12-13T23:59:59+01:00'}};
const dd=x=>new Date(x).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Africa/Lagos'});
const state=k=>{const n=Date.now(),w=WIN[k];return n<new Date(w.open)?'before':n>new Date(w.close)?'closed':'open'};
const msg=k=>{const w=WIN[k];return state(k)==='before'?`The ${w.name} opens on ${dd(w.open)}.`:`The ${w.name} closed on ${dd(w.close)} at 11:59pm.`};
const gate=k=>(q,s,n)=>state(k)==='open'?n():s.status(403).json({error:msg(k)});
const POS=(E.POSITIONS||'President,Vice President,General Secretary,Assistant General Secretary,Financial Secretary,Treasurer,Public Relation Officer,Director of Sport,Director of Welfare,Director of Social,Librarian,Chief Whip,Auditor').split(',').map(x=>x.trim());
const PRICES={'President':7000,'Vice President':6000,'General Secretary':5000};
const priceOf=p=>PRICES[p]||4000;
app.get('/api/config',(q,s)=>s.json({bank:E.BANK_NAME||'',accName:E.ACCOUNT_NAME||'',accNo:E.ACCOUNT_NUMBER||'',windows:Object.fromEntries(Object.keys(WIN).map(k=>[k,{state:state(k),open:dd(WIN[k].open),close:dd(WIN[k].close),msg:msg(k)}])),positions:POS,fees:Object.fromEntries(POS.map(p=>[p,priceOf(p)]))}));

pool.query(`CREATE TABLE IF NOT EXISTS voters(id SERIAL PRIMARY KEY,ref TEXT UNIQUE,phone TEXT UNIQUE,data JSONB NOT NULL,status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS voter_files(voter_id INT REFERENCES voters(id) ON DELETE CASCADE,kind TEXT,mime TEXT,name TEXT,data BYTEA,PRIMARY KEY(voter_id,kind));`).catch(e=>console.error('DB init failed',e));
const FILES=[['passport',1],['admission',1],['lgaProof',1],['receipt',1]];
app.post('/api/apply',gate('apply'),up.fields(FILES.map(([name])=>({name,maxCount:1}))),async(q,s)=>{
 try{
  const f=q.files||{},b=q.body;
  for(const k of['fullName','gender','dob','phone','email','address','lga','position','ward','faculty','matricNo','institution','qualification','department','level'])
   if(!b[k]||!b[k].trim())return s.status(400).json({error:'Please fill in all required fields.'});
  if(!/^\S+@\S+\.\S+$/.test((b.email||'').trim()))return s.status(400).json({error:'Please enter a valid email address.'});
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

  sendMail(data.email,data.fullName,`FISUEC 2026: Application received (${ref})`,`Dear ${data.fullName},\n\nThank you for applying for the position of ${data.position}. Your application has been received.\n\nReference number: ${ref}\nForm fee: ₦${Number(data.fee).toLocaleString('en-NG')}\n\nThe electoral committee will review your documents and payment, and you will receive another email with the outcome. Please keep your reference number.\n\nFISU Electoral Committee`);
  s.json({ref});
 }catch(e){console.error(e);s.status(500).json({error:'Something went wrong. Please try again.'})}
});

app.post('/api/login',(q,s)=>{
 if(q.body.password!==PASS)return s.status(401).json({error:'Wrong password.'});
 s.setHeader('Set-Cookie',`fisu=${TOKEN}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict${E.NODE_ENV==='production'||E.RENDER||E.RAILWAY_ENVIRONMENT?'; Secure':''}`);s.json({ok:1});
});
app.get('/api/admin/list',auth,async(q,s)=>{const r=await pool.query('SELECT id,ref,data,status,created_at FROM applicants ORDER BY id DESC');s.json(r.rows)});
app.post('/api/admin/status/:id',auth,async(q,s)=>{await pool.query('UPDATE applicants SET status=$1 WHERE id=$2',[q.body.status,q.params.id]);s.json({ok:1})});
app.get('/api/admin/file/:id/:kind',auth,async(q,s)=>{
 const r=await pool.query('SELECT mime,data FROM files WHERE applicant_id=$1 AND kind=$2',[q.params.id,q.params.kind]);
 if(!r.rows[0])return s.sendStatus(404);s.type(r.rows[0].mime).send(r.rows[0].data);
});

app.post('/api/register',gate('voters'),up.fields([{name:'passport',maxCount:1},{name:'lgaProof',maxCount:1},{name:'receipt',maxCount:1},{name:'admission',maxCount:1}]),async(q,s)=>{
 try{
  const f=q.files||{},b=q.body,T=k=>(b[k]||'').trim(),bad=m=>s.status(400).json({error:m});
  for(const k of['fullName','gender','dob','phone','email','address','lga','ward','residency','category'])if(!T(k))return bad('Please fill in all required fields.');
  if(!/^\S+@\S+\.\S+$/.test(T('email')))return bad('Please enter a valid email address.');
  const phone=T('phone').replace(/[\s-]/g,'');
  if(!/^\+?\d{10,14}$/.test(phone))return bad('Please enter a valid phone number.');
  if(!['Indigene','Non-indigene'].includes(T('residency'))||!['SSS 3 student','Undergraduate','Graduate'].includes(T('category')))return bad('Invalid selection.');
  if(T('residency')==='Non-indigene'&&!(+T('years')>=5))return bad('Non-indigenes must have lived in the town for at least 5 years.');
  const nonInd=T('residency')==='Non-indigene',refPhone=T('refPhone').replace(/[\s-]/g,'');
  if(nonInd&&(!T('refName')||!/^\+?\d{10,14}$/.test(refPhone)))return bad("Please enter your referee's full name and a valid phone number.");
  if(nonInd&&refPhone===phone)return bad('Your referee cannot use your own phone number.');
  const sss=T('category')==='SSS 3 student';
  if(sss?!T('school'):!(T('institution')&&T('course')))return bad(sss?'Please enter the name of your school.':'Please enter your institution and course.');
  if(!sss&&!f.admission)return bad('Please upload your proof of admission.');
  if(!f.passport)return bad('Please upload your passport photograph.');
  if(!f.lgaProof)return bad('Please upload your proof of LGA of origin.');
  if(!f.receipt)return bad('Please upload your membership payment receipt.');
  for(const k in f)if(!/^(image\/(jpe?g|png|webp)|application\/pdf)$/.test(f[k][0].mimetype))return bad('Only JPG, PNG or PDF files are allowed.');
  const data={};['fullName','gender','dob','email','address','lga','ward','residency','years','category','school','institution','course'].forEach(k=>data[k]=T(k));data.phone=phone;if(nonInd){data.refName=T('refName');data.refPhone=refPhone}
  const ref='FISUV-'+crypto.randomBytes(3).toString('hex').toUpperCase();
  const c=await pool.connect();
  try{await c.query('BEGIN');
   const r=await c.query('INSERT INTO voters(ref,phone,data) VALUES($1,$2,$3) RETURNING id',[ref,phone,data]);
   for(const k in f)await c.query('INSERT INTO voter_files VALUES($1,$2,$3,$4,$5)',[r.rows[0].id,k,f[k][0].mimetype,f[k][0].originalname,f[k][0].buffer]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}

  sendMail(data.email,data.fullName,`FISUEC 2026: Voter registration received (${ref})`,`Dear ${data.fullName},\n\nYour voter registration has been received.\n\nYour Voter ID: ${ref}\n\nThe electoral committee will review your submission and you will receive another email with the outcome. Please keep your Voter ID for accreditation.${sss?'\n\nSSS 3 students: remember to bring your promotion report sheet to the venue on election day.':''}\n\nFISU Electoral Committee`);
  s.json({ref});
 }catch(e){if(e.code==='23505')return s.status(409).json({error:'This phone number is already registered.'});console.error(e);s.status(500).json({error:'Something went wrong. Please try again.'})}
});
app.get('/api/admin/voters',auth,async(q,s)=>{const r=await pool.query('SELECT id,ref,data,status,created_at FROM voters ORDER BY id DESC');s.json(r.rows)});
app.post('/api/admin/voter-status/:id',auth,async(q,s)=>{await pool.query('UPDATE voters SET status=$1 WHERE id=$2',[q.body.status,q.params.id]);s.json({ok:1})});
app.get('/api/admin/voter-file/:id/:kind',auth,async(q,s)=>{
 const r=await pool.query('SELECT mime,data FROM voter_files WHERE voter_id=$1 AND kind=$2',[q.params.id,q.params.kind]);
 if(!r.rows[0])return s.sendStatus(404);s.type(r.rows[0].mime).send(r.rows[0].data);
});
app.post('/api/admin/decide/:t/:id',auth,async(q,s)=>{
 try{
  const tb=q.params.t==='vot'?'voters':'applicants',{status,send,subject,body}=q.body;
  if(!['Pending','Qualified','Verified','Disqualified'].includes(status))return s.status(400).json({error:'Invalid status.'});
  if(send&&(!subject||!body))return s.status(400).json({error:'Subject and message are required.'});
  const r=await pool.query(`UPDATE ${tb} SET status=$1 WHERE id=$2 RETURNING data`,[status,q.params.id]);
  if(!r.rows[0])return s.sendStatus(404);
  const d=r.rows[0].data;
  s.json({ok:1,mail:send?await sendMail(d.email,d.fullName,subject,body):null});
 }catch(e){console.error(e);s.status(500).json({error:'Could not save.'})}
});
// ================= VOTING SYSTEM =================
process.on('unhandledRejection',e=>console.error('Unhandled',e));
app.set('trust proxy',1);
pool.query(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS candidates(applicant_id INT PRIMARY KEY,position TEXT,name TEXT);
CREATE TABLE IF NOT EXISTS vdevices(id SERIAL PRIMARY KEY,name TEXT,token_hash TEXT UNIQUE,revoked BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now(),last_seen TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS voted(voter_id INT PRIMARY KEY,device_id INT,at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS ballots(id UUID DEFAULT gen_random_uuid() PRIMARY KEY,position TEXT,candidate_id INT);`).catch(e=>console.error('Vote DB init failed',e));
app.get('/vote',(q,s)=>s.sendFile(__dirname+'/public/vote.html'));
app.get('/screen',(q,s)=>s.sendFile(__dirname+'/public/screen.html'));
const W=fn=>(q,s,n)=>fn(q,s,n).catch(e=>{console.error(e);s.status(500).json({error:'Server error. Please try again.'})});
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const SEC=E.SECRET||PASS;
const mac=p=>crypto.createHmac('sha256',SEC).update(p).digest('base64url');
const sign=o=>{const p=Buffer.from(JSON.stringify(o)).toString('base64url');return p+'.'+mac(p)};
const unsign=t=>{try{const[p,g]=String(t).split('.');if(!p||g!==mac(p))return null;const o=JSON.parse(Buffer.from(p,'base64url'));return o.exp>Date.now()?o:null}catch{return null}};
const order=p=>{const i=POS.indexOf(p);return i<0?99:i};
const getS=async()=>{const r=await pool.query('SELECT k,v FROM settings');const m=Object.fromEntries(r.rows.map(x=>[x.k,x.v]));return{state:m.vstate||'pending',reveal:+(m.reveal??-1)}};
const setS=(k,v)=>pool.query('INSERT INTO settings VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2',[k,String(v)]);
const counts=async()=>(await pool.query("SELECT (SELECT count(*) FROM voters WHERE status='Verified')::int AS eligible,(SELECT count(*) FROM voted)::int AS voted")).rows[0];
async function tally(){
 const cs=(await pool.query('SELECT applicant_id AS id,position,name FROM candidates')).rows;
 const bs=(await pool.query('SELECT position,candidate_id AS id,count(*)::int AS n FROM ballots GROUP BY 1,2')).rows;
 const g={};cs.forEach(c=>(g[c.position]=g[c.position]||{position:c.position,candidates:[],abstain:0,total:0}).candidates.push({id:c.id,name:c.name,votes:0}));
 bs.forEach(b=>{const p=g[b.position];if(!p)return;p.total+=b.n;if(b.id==null)p.abstain=b.n;else{const c=p.candidates.find(x=>x.id===b.id);if(c)c.votes=b.n}});
 return Object.values(g).sort((a,b)=>order(a.position)-order(b.position)).map(p=>{
  const m=Math.max(...p.candidates.map(c=>c.votes));
  p.candidates.sort((a,b)=>b.votes-a.votes||a.name.localeCompare(b.name));
  p.tie=m>0&&p.candidates.filter(c=>c.votes===m).length>1;
  p.candidates.forEach(c=>{c.winner=m>0&&c.votes===m;c.pct=p.total?Math.round(c.votes*1000/p.total)/10:0});return p});
}
const candPhoto=async(q,s)=>{const r=await pool.query("SELECT f.mime,f.data FROM files f JOIN candidates c ON c.applicant_id=f.applicant_id WHERE f.applicant_id=$1 AND f.kind='passport'",[+q.params.id]);
 if(!r.rows[0])return s.sendStatus(404);s.set('Cache-Control','private, max-age=600').type(r.rows[0].mime).send(r.rows[0].data)};

// ---- device pairing (only paired devices can open the voting booth)
const codes=new Map(),bad=new Map();
app.post('/api/admin/vote/pair',auth,(q,s)=>{const code=String(crypto.randomInt(100000,999999));codes.set(code,{name:String(q.body.name||'Device').slice(0,40),exp:Date.now()+15*60000});s.json({code})});
app.post('/api/vote/pair',W(async(q,s)=>{
 const b=bad.get(q.ip)||{n:0,exp:0};if(b.exp>Date.now()&&b.n>=10)return s.status(429).json({error:'Too many attempts. Try again later.'});
 const code=String(q.body.code||'').trim(),c=codes.get(code);
 if(!c||c.exp<Date.now()){bad.set(q.ip,{n:(b.exp>Date.now()?b.n:0)+1,exp:Date.now()+10*60000});return s.status(400).json({error:'Invalid or expired code.'})}
 codes.delete(code);const token=crypto.randomBytes(32).toString('hex');
 await pool.query('INSERT INTO vdevices(name,token_hash) VALUES($1,$2)',[c.name,sha(token)]);s.json({token})}));
const dev=W(async(q,s,n)=>{const t=q.headers['x-device'];
 const r=t&&await pool.query('UPDATE vdevices SET last_seen=now() WHERE token_hash=$1 AND NOT revoked RETURNING id',[sha(t)]);
 if(!r||!r.rows[0])return s.status(401).json({error:'This device is not authorised.',code:'DEVICE'});q.devId=r.rows[0].id;n()});
const sess=(q,s,n)=>{const o=unsign(q.headers['x-session']);if(!o||o.d!==q.devId)return s.status(401).json({error:'Session expired. Please log in again.',code:'SESSION'});q.voter=o.v;n()};

// ---- voting booth
app.post('/api/vote/login',dev,W(async(q,s)=>{
 const S=await getS();if(S.state!=='open')return s.status(400).json({error:S.state==='pending'?'Voting has not started yet.':'Voting has ended.'});
 const v=(await pool.query('SELECT id,data,status FROM voters WHERE ref=$1',[String(q.body.ref||'').trim().toUpperCase()])).rows[0];
 if(!v)return s.status(404).json({error:'Voter ID not found.'});
 if(v.status!=='Verified')return s.status(403).json({error:'This Voter ID has not been verified as eligible.'});
 if((await pool.query('SELECT 1 FROM voted WHERE voter_id=$1',[v.id])).rows[0])return s.status(403).json({error:'This Voter ID has already voted.'});
 s.json({name:v.data.fullName,category:v.data.category,session:sign({v:v.id,d:q.devId,exp:Date.now()+10*60000})})}));
app.get('/api/vote/photo',W(async(q,s)=>{const o=unsign(q.query.s);if(!o)return s.sendStatus(401);
 const r=await pool.query("SELECT mime,data FROM voter_files WHERE voter_id=$1 AND kind='passport'",[o.v]);if(!r.rows[0])return s.sendStatus(404);s.type(r.rows[0].mime).send(r.rows[0].data)}));
app.get('/api/vote/cand/:id',W(async(q,s)=>{if(!unsign(q.query.s))return s.sendStatus(401);return candPhoto(q,s)}));
app.get('/api/vote/ballot',dev,sess,W(async(q,s)=>{
 if((await getS()).state!=='open')return s.status(400).json({error:'Voting is not open.'});
 const g={};(await pool.query('SELECT applicant_id AS id,position,name FROM candidates')).rows.forEach(c=>(g[c.position]=g[c.position]||[]).push(c));
 s.json(Object.keys(g).sort((a,b)=>order(a)-order(b)).map(p=>({position:p,candidates:g[p].sort((a,b)=>a.name.localeCompare(b.name))})))}));
app.post('/api/vote/cast',dev,sess,W(async(q,s)=>{
 if((await getS()).state!=='open')return s.status(400).json({error:'Voting is not open.'});
 if((await pool.query('SELECT status FROM voters WHERE id=$1',[q.voter])).rows[0]?.status!=='Verified')return s.status(403).json({error:'Not eligible to vote.'});
 const ch=q.body.choices||{},cs=(await pool.query('SELECT applicant_id AS id,position FROM candidates')).rows;
 const rows=[...new Set(cs.map(c=>c.position))].map(p=>{const v=ch[p];if(v==='abstain')return[p,null];const c=cs.find(x=>x.id===+v&&x.position===p);return c?[p,c.id]:undefined});
 if(rows.includes(undefined))return s.status(400).json({error:'Invalid ballot. Please review your choices.'});
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query('INSERT INTO voted(voter_id,device_id) VALUES($1,$2)',[q.voter,q.devId]);
  for(const[p,id]of rows.sort(()=>Math.random()-.5))await c.query('INSERT INTO ballots(position,candidate_id) VALUES($1,$2)',[p,id]);
  await c.query('COMMIT')}
 catch(e){await c.query('ROLLBACK');if(e.code==='23505')return s.status(403).json({error:'This Voter ID has already voted.'});throw e}finally{c.release()}
 s.json({ok:1})}));

// ---- big screen (public: shows turnout only until the admin reveals results)
app.get('/api/screen/photo/:id',W(candPhoto));
app.get('/api/screen',W(async(q,s)=>{const S=await getS(),c=await counts();s.set('Cache-Control','no-store');
 if(S.state==='pending')return s.json({state:'pending'});
 if(S.state==='open'||S.reveal<0)return s.json({state:S.state,...c});
 const t=await tally();
 if(S.reveal>=t.length)return s.json({state:'final',...c,results:t});
 s.json({state:'reveal',...c,index:S.reveal,total:t.length,result:t[S.reveal]})}));

// ---- admin controls
app.get('/api/admin/vote',auth,W(async(q,s)=>{const S=await getS(),c=await counts();
 const cands=S.state==='pending'?(await pool.query("SELECT id,data->>'position' AS position,data->>'fullName' AS name FROM applicants WHERE status='Qualified'")).rows
  :(await pool.query('SELECT applicant_id AS id,position,name FROM candidates')).rows;
 const g={};cands.forEach(x=>(g[x.position]=g[x.position]||[]).push(x.name));
 s.json({...S,...c,positions:Object.keys(g).sort((a,b)=>order(a)-order(b)).map(p=>({position:p,names:g[p]})),
  devices:(await pool.query('SELECT id,name,revoked,last_seen FROM vdevices ORDER BY id DESC')).rows,results:S.state==='closed'?await tally():null})}));
app.post('/api/admin/vote/start',auth,W(async(q,s)=>{
 if((await getS()).state!=='pending')return s.status(400).json({error:'Voting has already started.'});
 await pool.query('DELETE FROM candidates');
 const r=await pool.query("INSERT INTO candidates SELECT id,data->>'position',data->>'fullName' FROM applicants WHERE status='Qualified'");
 if(!r.rowCount)return s.status(400).json({error:'No applicants are marked Qualified yet.'});
 await setS('vstate','open');await setS('reveal',-1);s.json({ok:1})}));
app.post('/api/admin/vote/end',auth,W(async(q,s)=>{if((await getS()).state!=='open')return s.status(400).json({error:'Voting is not open.'});await setS('vstate','closed');await setS('reveal',-1);s.json({ok:1})}));
app.post('/api/admin/vote/reopen',auth,W(async(q,s)=>{const S=await getS();if(S.state!=='closed'||S.reveal>=0)return s.status(400).json({error:'Cannot reopen now.'});await setS('vstate','open');s.json({ok:1})}));
app.post('/api/admin/vote/reveal',auth,W(async(q,s)=>{const S=await getS();if(S.state!=='closed')return s.status(400).json({error:'End the voting first.'});
 const n=(await pool.query('SELECT count(DISTINCT position)::int AS n FROM candidates')).rows[0].n,a=q.body.action;
 const r=a==='next'?Math.min(S.reveal+1,n):a==='prev'?Math.max(S.reveal-1,-1):a==='all'?n:-1;await setS('reveal',r);s.json({reveal:r})}));
app.post('/api/admin/vote/revoke/:id',auth,W(async(q,s)=>{await pool.query('UPDATE vdevices SET revoked=true WHERE id=$1',[+q.params.id]);s.json({ok:1})}));
app.post('/api/admin/vote/reset',auth,W(async(q,s)=>{if(q.body.confirm!=='RESET')return s.status(400).json({error:'Type RESET to confirm.'});
 await pool.query('TRUNCATE ballots,voted,candidates');await setS('vstate','pending');await setS('reveal',-1);s.json({ok:1})}));

app.use((e,q,s,n)=>s.status(400).json({error:e.code==='LIMIT_FILE_SIZE'?'Each file must be 3MB or less.':'Upload failed.'}));
app.listen(E.PORT||3000,()=>console.log('FISU forms running'));
