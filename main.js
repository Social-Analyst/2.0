const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const ses = () => session.fromPartition('persist:ig');

function createWindow() {
  const w = new BrowserWindow({ width: 1200, height: 800, backgroundColor: '#09090b',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  w.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
}

// Embedded login window: user signs in on Instagram's own page; cookies stay in a local persistent partition.
ipcMain.handle('ig:login', () => new Promise((resolve, reject) => {
  const w = new BrowserWindow({ width: 480, height: 760, title: 'Log in to Instagram', webPreferences: { partition: 'persist:ig' } });
  w.loadURL('https://www.instagram.com/accounts/login/');
  const t = setInterval(async () => {
    const c = await ses().cookies.get({ url: 'https://www.instagram.com' });
    const v = n => c.find(x => x.name === n)?.value;
    if (v('sessionid') && v('ds_user_id')) { clearInterval(t); const s = { userId: v('ds_user_id'), csrftoken: v('csrftoken') }; w.close(); resolve(s); }
  }, 1500);
  w.on('closed', () => { clearInterval(t); reject(new Error('Login window closed')); });
}));

ipcMain.handle('ig:request', async (_, { path: p, method, body, csrftoken }) => {
  const r = await ses().fetch('https://www.instagram.com' + p, { method, body, credentials: 'include',
    headers: { 'X-IG-App-ID': '936619743392459', 'X-CSRFToken': csrftoken, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' } });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
