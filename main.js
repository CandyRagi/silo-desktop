const { app, BrowserWindow } = require('electron')
const path = require('node:path')

function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  // Load your HTML file
  mainWindow.loadFile('index.html')
}

// Run when Electron has finished initialization
app.whenReady().then(() => {
  createWindow()

  // On macOS, apps commonly stay active even without windows open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
