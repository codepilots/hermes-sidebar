const log=document.getElementById('log'),q=document.getElementById('q'),inc=document.getElementById('inc'),pageEl=document.getElementById('page');
let history=[];const MAX=60000;
function add(role,text){const d=document.createElement('div');d.className='m '+role;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
async function tab(){const [t]=await chrome.tabs.query({active:true,currentWindow:true});return t;}
async function showTab(){const t=await tab();pageEl.textContent=t?(t.title||t.url):'';}
chrome.tabs.onActivated.addListener(showTab);chrome.tabs.onUpdated.addListener((i,c)=>c.title&&showTab());showTab();
async function grab(){const t=await tab();
  try{const [r]=await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>({sel:String(getSelection()),text:document.body?document.body.innerText:''})});
    return {url:t.url,title:t.title,...r.result};}
  catch(e){return {url:t.url,title:t.title,text:'',sel:'',err:e.message};}}
document.getElementById('clear').onclick=()=>{history=[];log.innerHTML='';};
q.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
document.getElementById('f').onsubmit=e=>{e.preventDefault();send();};
async function send(){
  const text=q.value.trim();if(!text)return;q.value='';
  const {endpoint='http://127.0.0.1:8642',key=''}=await chrome.storage.local.get(['endpoint','key']);
  if(!key){add('err','Set your API key in settings (⚙) first.');return;}
  let content=text;
  if(inc.checked){const p=await grab();
    let ctx=`[Page: ${p.title}]\n[URL: ${p.url}]\n`;
    if(p.sel)ctx+=`[Selected text]\n${p.sel}\n`;
    if(p.text)ctx+=`[Page text${p.text.length>MAX?' (truncated)':''}]\n${p.text.slice(0,MAX)}\n`;
    if(p.err)ctx+=`[Could not read page text: ${p.err}]\n`;
    content=ctx+'\n[Question]\n'+text;}
  add('user',text);history.push({role:'user',content});
  const out=add('assistant','…');let acc='';
  try{const r=await fetch(endpoint.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
      body:JSON.stringify({model:'hermes-agent',stream:true,messages:[{role:'system',content:'The user is asking from a Chromium sidebar about the web page they are reading. Page context is attached to their messages. Be concise.'},...history]})});
    if(!r.ok)throw new Error(r.status+' '+await r.text());
    const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
    for(;;){const {done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
        if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;
        try{const d=JSON.parse(data).choices?.[0]?.delta?.content;if(d){acc+=d;out.textContent=acc;log.scrollTop=log.scrollHeight;}}catch{}}}
    history.push({role:'assistant',content:acc});
  }catch(e){out.className='m err';out.textContent='Error: '+e.message;history.pop();}
}
