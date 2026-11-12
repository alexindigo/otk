#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-only
"""Guest-only: stock V1 initializes DB, seed stopped clone, stock V2 migrates."""
import base64, json, os, pathlib, re, shutil, signal, sqlite3, subprocess, time, urllib.request
W=pathlib.Path.cwd(); R=W/'.test-state'/('migrated-history-'+str(time.time_ns()))
R.mkdir(parents=True,exist_ok=False)
env=dict(os.environ)
for key,sub in {'HOME':'home','TMPDIR':'tmp','XDG_CONFIG_HOME':'config','XDG_DATA_HOME':'data','XDG_STATE_HOME':'state','XDG_CACHE_HOME':'cache'}.items():
    p=R/sub;p.mkdir();env[key]=str(p)
env.update(OPENCODE_PURE='1',OPENCODE_CONFIG_PROJECT_DISABLE='1',OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1',OPENCODE_DISABLE_EXTERNAL_SKILLS='1',OPENCODE_DISABLE_MODELS_FETCH='1',OPENCODE_SERVER_PASSWORD='fixture',OPENCODE_PASSWORD='fixture')
project=R/'project';project.mkdir()
for directory in [R/'config/opencode',project/'.opencode']:
    directory.mkdir(parents=True)
    cache=pathlib.Path('/opt/otk-test/provider-cache/opencode-1.19.3/dependencies')
    for name in ['package.json','package-lock.json']:shutil.copy2(cache/name,directory/name)
    (directory/'node_modules').symlink_to(cache/'node_modules',target_is_directory=True)
(R/'config/opencode/opencode.json').write_text(json.dumps({'autoupdate':False,'share':'disabled'}))
def req(url,body=None,auth='fixture'):
    data=None if body is None else json.dumps(body).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(url,data=data,headers={'Authorization':'Basic '+base64.b64encode(('opencode:'+auth).encode()).decode(),'Content-Type':'application/json'}),timeout=60))
def start(version,port):
    log=(R/('native-'+version+'.log')).open('w')
    args=['/opt/otk-test/opencode/'+version+'/opencode','serve','--hostname','127.0.0.1','--port',str(port)]
    if version.startswith('2.'):args.append('--service')
    p=subprocess.Popen(args,env=env,cwd=project,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    return p,log
def stop(p,log):
    os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=20)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    log.close()
p,log=start('1.19.3',49193)
try:
    for _ in range(150):
        try:
            session=req('http://127.0.0.1:49193/session?directory='+str(project),{'title':'INV-E legacy fixture'});break
        except Exception:
            assert p.poll() is None;time.sleep(.2)
    else:raise RuntimeError('V1 startup deadline')
finally:stop(p,log)
dbpath=R/'data/opencode/opencode.db'
db=sqlite3.connect(dbpath);db.row_factory=sqlite3.Row
sid=session['id']; T=1792786310000; LATE=T+923594200
user='msg_inve00000000000000000000001'
tokens={'input':100,'output':20,'reasoning':3,'cache':{'read':0,'write':0}}
def message(mid,data,created,updated):
    db.execute('INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)',(mid,sid,created,updated,json.dumps(data)))
def part(mid,n,data):
    db.execute('INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)',('prt_inve'+str(n).zfill(23),mid,sid,T+n,T+n,json.dumps(data)))
def usermsg(mid,clock):
    message(mid,{'role':'user','time':{'created':clock},'agent':'build','model':{'providerID':'fake','modelID':'scripted'}},clock,clock)
usermsg(user,T-1000);part(user,0,{'type':'text','text':'Inspect legacy tool history'})
inputs=[('read',{'filePath':'/fixture/alpha.ts'}),('apply_patch',{'patchText':'*** Begin Patch\n*** Update File: /fixture/alpha.ts\n@@\n-old\n+new\n*** End Patch'}),('read',{'filePath':'/fixture/beta.ts','offset':190,'limit':50}),('bash',{'command':'pwd','workdir':'/fixture'}),('task',{'subagent_type':'junior','description':'Legacy helper','task_id':'ses_child'}),('skill',{'name':'legacy-skill'}),('edit',{'filePath':'/fixture/edit.ts','oldString':'old','newString':'new'}),('write',{'filePath':'/fixture/new.ts','content':'new'}),('read',{'filePath':'/fixture/dir'}),('custom',{'query':'native extension'}),('read',{'filePath':'/fixture/running.ts'}),('read',{'filePath':'/fixture/pending.ts'})]
native=[]
for i in range(3):
    mid='msg_inve'+str(i+2).zfill(23);created=T+i*1000;completed=created+500
    data={'role':'assistant','time':{'created':created,'completed':completed},'parentID':user,'modelID':'scripted','providerID':'fake','mode':'build','agent':'junior','path':{'cwd':str(project),'root':str(project)},'cost':0,'tokens':tokens,'finish':'tool-calls'}
    if i==2:data['error']={'name':'MessageAbortedError','data':{'message':'interrupted fixture'}}
    message(mid,data,created,LATE if i==2 else completed)
    native.append({'id':mid,'sessionID':sid,**data})
    for j,(name,inp) in enumerate(inputs[i*4:(i+1)*4],start=i*4):
        meta={};output='ok'
        if name=='apply_patch':meta={'files':[{'filePath':'/fixture/alpha.ts','type':'update','patch':'--- a/fixture/alpha.ts\n+++ b/fixture/alpha.ts\n@@ -1 +1 @@\n-old\n+new'}]}
        if name=='task':meta={'sessionId':'ses_child'}
        if j==8:meta={'display':{'type':'directory','totalEntries':1}};output='<path>/fixture/dir</path>\n<type>directory</type>\n<entries>\na.ts\n</entries>'
        state={'status':'completed','input':inp,'output':output,'title':'Legacy title','metadata':meta,'time':{'start':created+10,'end':created+100}}
        if j==2:state={'status':'error','input':inp,'error':'File not found','time':{'start':created+10,'end':created+100}}
        if j==10:state={'status':'running','input':inp,'time':{'start':created+10},'metadata':{}}
        if j==11:state={'status':'pending','input':inp,'raw':'{}'}
        tool={'type':'tool','callID':'call_inve_'+str(j),'tool':name,'state':state};part(mid,j+1,tool)
        native[-1].setdefault('parts',[]).append({'id':'prt_inve'+str(j+1).zfill(23),'messageID':mid,'sessionID':sid,**tool})
# Next prompt is intentionally much later; its time is not an assistant endpoint.
usermsg('msg_inve00000000000000000000005',LATE+86400000)
db.commit()
with sqlite3.connect(R/'v1-before-migration.db') as backup:db.backup(backup)
(R/'v1-seeded.json').write_text(json.dumps(native,indent=2))
(R/'v1-row-clocks.json').write_text(json.dumps([dict(r) for r in db.execute('SELECT id,time_created,time_updated,data FROM message WHERE session_id=? ORDER BY time_created',(sid,))],indent=2))
db.close()
if os.environ.get('INV_E_V1_READ')=='1':
    # Optional extra probe, not needed to exercise the actual native migration.
    # This currently times out on the seeded restart; failed logs are retained.
    p,log=start('1.19.3',49193)
    try:
        for _ in range(150):
            try:
                observed=req('http://127.0.0.1:49193/session/'+sid+'/message?directory='+str(project));break
            except urllib.error.URLError:
                assert p.poll() is None;time.sleep(.2)
        else:raise RuntimeError('V1 reload deadline')
        (R/'v1-api.json').write_text(json.dumps(observed,indent=2))
        native=[{**m['info'],'parts':m['parts']} for m in observed if m['info']['role']=='assistant']
    finally:stop(p,log)
(R/'config/opencode/opencode.json').write_text('{}')
p,log=start('2.2.6',49226)
try:
    registration=R/'state/opencode/service.json'
    for _ in range(600):
        try:
            service=json.loads(registration.read_text());url=service['url'];password=service['password']
            status=req(url+'/api/experimental/migration/v1',auth=password)
            if status['status']=='error':raise RuntimeError(status)
            if status['status']=='completed':break
        except (FileNotFoundError,ConnectionError,urllib.error.URLError):pass
        assert p.poll() is None;time.sleep(.2)
    else:raise RuntimeError('V2 migration deadline')
    api=req(url+'/api/session/'+sid+'/message?limit=200&order=asc',auth=password)
    (R/'v2-api.json').write_text(json.dumps(api,indent=2))
    (R/'migration-status.json').write_text(json.dumps(status))
finally:stop(p,log)
db=sqlite3.connect(dbpath);db.row_factory=sqlite3.Row
rows=[dict(r) for r in db.execute('SELECT id,type,seq,time_created,time_updated,data FROM session_message WHERE session_id=? ORDER BY seq',(sid,))]
(R/'v2-migrated-rows.json').write_text(json.dumps(rows,indent=2));db.close()
fixture={'provenance':{'v1':'1.19.3','v2':'2.2.6','route':'stock V1 initializes SQLite; stopped private fixture seed; stock V2 migration; native V2 HTTP response','rowMismatchSeeded':True,'v1HistoryHTTP':os.environ.get('INV_E_V1_READ')=='1'},'v1':native,'v2':api['data'],'firstCreated':T,'originalEnd':T+2500,'migratedEnd':LATE,'nextPrompt':LATE+86400000}
(R/'fixture.json').write_text(json.dumps(fixture,indent=2))
print(json.dumps({'session':sid,'nativeMessages':len(api['data']),'fixture':str(R/'fixture.json')}))
