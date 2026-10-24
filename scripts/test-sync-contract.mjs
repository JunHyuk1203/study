import {spawnSync} from 'node:child_process';
// An argument array preserves the pattern through Windows emulator command shells.
const result=spawnSync(process.execPath,['--test','--test-name-pattern=camera events|word ownership|manual browser heartbeats|camera sessions enforce','tests/firebase.test.mjs'],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
