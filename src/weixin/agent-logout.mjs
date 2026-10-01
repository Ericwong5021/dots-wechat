import fs from 'node:fs/promises';
import path from 'node:path';

export async function agentLocalLogout(options, io, { checkDirectory, readCredential, fail, identity }) {
  const snapshot = await readCredential(options.stateDir, true);
  const filenames = ['credentials.json', 'verify-state.json'];
  const identities = new Map([['credentials.json', snapshot.credentialIdentity]]);
  const facts = { localCredentialsDeleted: false, localVerifyStateDeleted: false, localVerifyStateAbsent: false, directoryRemoved: false, remoteRevocation: 'NOT_ATTEMPTED', remoteRevocationConfirmed: false };
  let store;
  let interrupted = false;
  let mutationStarted = false;
  let failure;
  const interrupt = () => { interrupted = true; };
  const checkStopped = () => { if (interrupted) fail('LOGOUT_INTERRUPTED'); };
  async function checkFiles(withLock = false, capture = false) {
    checkStopped();
    if (!identity(snapshot.directoryIdentity, await checkDirectory(options.stateDir))) fail('STATE_DIRECTORY_CHANGED');
    const allowed = [...filenames, ...(withLock ? ['verify-state.json.lock'] : [])];
    const names = await fs.readdir(options.stateDir);
    if (!withLock && names.includes('verify-state.json.lock')) fail('STATE_LOCKED');
    if (names.some(name => !allowed.includes(name))) fail('UNRECOGNIZED_STATE_FILES');
    for (const name of allowed) {
      let stat;
      try { stat = await fs.lstat(path.join(options.stateDir, name)); }
      catch (error) {
        if (error.code !== 'ENOENT' || name !== 'verify-state.json') throw error;
        if (identities.has(name)) fail('LOCAL_FILE_CHANGED');
        facts.localVerifyStateAbsent = true;
        continue;
      }
      if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) fail('LOCAL_FILE_INSECURE');
      if (name === 'verify-state.json' && facts.localVerifyStateAbsent) fail('LOCAL_FILE_CHANGED');
      if (identities.has(name) && !identity(identities.get(name), stat)) fail('LOCAL_FILE_CHANGED');
      if (!identities.has(name)) {
        if (!capture) fail('LOCAL_FILE_CHANGED');
        identities.set(name, stat);
      }
    }
    checkStopped();
  }
  io.signalSource.on('SIGINT', interrupt);
  io.signalSource.on('SIGTERM', interrupt);
  try {
    await checkFiles(false, true);
    store = await io.createStateStore({ statePath: path.join(options.stateDir, 'verify-state.json') });
    await checkFiles(true, true);
    for (const name of ['verify-state.json', 'credentials.json']) {
      if (name === 'verify-state.json' && facts.localVerifyStateAbsent) continue;
      await checkFiles(true);
      mutationStarted = true;
      await fs.unlink(path.join(options.stateDir, name));
      if (name === 'credentials.json') facts.localCredentialsDeleted = true;
      else facts.localVerifyStateDeleted = true;
      filenames.splice(filenames.indexOf(name), 1);
      identities.delete(name);
    }
  } catch (error) { failure = error; }
  if (store) {
    try { await store.close(); }
    catch (error) { failure ??= error; }
  }
  try {
    if (!failure) {
      checkStopped();
      if (!identity(snapshot.directoryIdentity, await checkDirectory(options.stateDir))) fail('STATE_DIRECTORY_CHANGED');
      if ((await fs.readdir(options.stateDir)).length !== 0) fail('UNRECOGNIZED_STATE_FILES');
      await fs.rmdir(options.stateDir);
      facts.directoryRemoved = true;
    }
  } catch (error) { failure = error; }
  finally {
    io.signalSource.off('SIGINT', interrupt);
    io.signalSource.off('SIGTERM', interrupt);
  }
  if (failure) {
    if (mutationStarted) io.result({ status: 'LOCAL_LOGOUT_UNKNOWN', ...facts });
    throw failure;
  }
  io.result({ status: 'LOCAL_LOGOUT', ...facts });
  return 0;
}
