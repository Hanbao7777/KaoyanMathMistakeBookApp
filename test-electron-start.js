// Verify Electron can expose the app module in the current launch environment.

try {
  // Attempt to require electron - this should work if ELECTRON_RUN_AS_NODE is cleared
  const electron = require('electron');

  if (electron && typeof electron.app !== 'undefined') {
    console.log('PASS: require("electron").app is available');
    console.log('  app.getName():', electron.app.getName());
    console.log('  app.getVersion():', electron.app.getVersion());
    console.log('  app.isReady():', electron.app.isReady());
  } else if (electron) {
    console.log('FAIL: electron module loaded but .app is undefined');
    console.log('  electron keys:', Object.keys(electron).slice(0, 10));
  } else {
    console.log('FAIL: require("electron") returned falsy');
  }
} catch (err) {
  console.log('FAIL: require("electron") threw:', err.message);
}

// Signal test completion
process.exit(0);
