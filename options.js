const e=document.getElementById('endpoint'),k=document.getElementById('key');
chrome.storage.local.get(['endpoint','key']).then(v=>{e.value=v.endpoint||'http://127.0.0.1:8642';k.value=v.key||'';});
document.getElementById('save').onclick=async()=>{await chrome.storage.local.set({endpoint:e.value.trim(),key:k.value.trim()});
document.getElementById('st').textContent='Saved';};
