const path = require('path');
const { mkdirp, readFile, writeFile, move, pathExists } = require('fs-extra');

const execa = require('execa');
const { createLambda } = require('@now/build-utils/lambda.js'); // eslint-disable-line import/no-extraneous-dependencies
const getWritableDirectory = require('@now/build-utils/fs/get-writable-directory.js'); // eslint-disable-line import/no-extraneous-dependencies
const download = require('@now/build-utils/fs/download.js'); // eslint-disable-line import/no-extraneous-dependencies
const downloadGit = require('lambda-git');
const glob = require('@now/build-utils/fs/glob.js'); // eslint-disable-line import/no-extraneous-dependencies
const downloadGoBin = require('./download-go-bin');

// creates a `$GOPATH` directory tree, as per
// `go help gopath`'s instructions.
// without this, Go won't recognize the `$GOPATH`
async function createGoPathTree(goPath) {
  await mkdirp(path.join(goPath, 'bin'));
  await mkdirp(path.join(goPath, 'pkg', 'linux_amd64'));
}

exports.config = {
  maxLambdaSize: '10mb',
};

exports.build = async ({ files, entrypoint }) => {
  console.log('downloading files...');

  const gitPath = await getWritableDirectory();
  const goPath = await getWritableDirectory();
  const srcPath = path.join(goPath, 'src', 'lambda');
  const outDir = await getWritableDirectory();

  await createGoPathTree(goPath);

  const downloadedFiles = await download(files, srcPath);

  console.log('downloading go binary...');
  const goBin = await downloadGoBin();

  console.log('downloading git binary...');
  // downloads a git binary that works on Amazon Linux and sets
  // `process.env.GIT_EXEC_PATH` so `go(1)` can see it
  await downloadGit({ targetDirectory: gitPath });

  const goEnv = {
    ...process.env,
    GOOS: 'linux',
    GOARCH: 'amd64',
    GOPATH: goPath,
  };

  const goModEnv = {
    ...process.env,
    GOOS: 'linux',
    GOARCH: 'amd64',
    GOPATH: goPath,
    GO111MODULE: 'on',
  };

  console.log(`parsing AST for "${entrypoint}"`);
  let parseStdout = '';
  try {
    parseStdout = await execa.stdout(
      path.join(__dirname, 'bin', 'get-exported-function-name'),
      [downloadedFiles[entrypoint].fsPath],
    );
  } catch (err) {
    console.log(`failed to parse AST for "${entrypoint}"`);
    throw err;
  }

  if (parseStdout === '') {
    const e = new Error(
      `Could not find an exported function on "${entrypoint}"`,
    );
    console.log(e.message);
    throw e;
  }

  let handlerFunctionName = parseStdout.split(',')[0];

  console.log(
    `Found exported function "${handlerFunctionName}" on "${entrypoint}"`,
  );

  // we need `main.go` in the same dir as the entrypoint,
  // otherwise `go build` will refuse to build
  const entrypointDirname = path.dirname(downloadedFiles[entrypoint].fsPath);

  // for backward compability
  // if entry not using main as package name
  // using go mod, otherwise using the previous flow
  let packageName = parseStdout.split(',')[1];
  const isGoModExist = await pathExists(`${entrypointDirname}/go.mod`);
  if (packageName !== 'main') {
    // initalize go mod with provide by user package
    try {
      if (!isGoModExist) {
        await execa(goBin, ['mod', 'init', `${packageName}`], {
          env: goModEnv,
          cwd: entrypointDirname,
          stdio: 'inherit',
        });
      }
    } catch (err) {
      console.log('failed to initialize `go mod`');
      throw err;
    }

    const mainModGoFileName = 'main__mod__.go';
    const modMainGoContents = await readFile(
      path.join(__dirname, mainModGoFileName),
      'utf8',
    );

    let goPackageName = `${packageName}/${packageName}`;
    let goFuncName = `${packageName}.${handlerFunctionName}`;
    if (isGoModExist) {
      let goModContents = await readFile(
        `${entrypointDirname}/go.mod`,
        'utf8',
      );
      goPackageName = `${goModContents.split('\n')[0].split(' ')[1]}/${packageName}`
    }

    const mainModGoContents = modMainGoContents
      .replace('__NOW_HANDLER_PACKAGE_NAME', goPackageName)
      .replace('__NOW_HANDLER_FUNC_NAME', goFuncName);

    // write main__mod__.go
    await writeFile(path.join(entrypointDirname, mainModGoFileName), mainModGoContents);

    console.log(mainModGoContents);

    try {
      await move(
        downloadedFiles[entrypoint].fsPath,
        `${path.join(entrypointDirname, packageName, entrypoint)}`
      )
    } catch (err) {
      console.log('failed to move entry to package folder');
      throw err;
    }

    console.log('installing dependencies');
    try {
      await execa(goBin, ['get'], {
        env: goModEnv,
        cwd: entrypointDirname,
        stdio: 'inherit',
      });
    } catch (err) {
      console.log('failed to `go get`');
      throw err;
    }

    console.log('running go build...');
    try {
      await execa(
        goBin,
        [
          'build',
          '-o',
          path.join(outDir, 'handler'),
          path.join(entrypointDirname, mainModGoFileName)
        ],
        { env: goModEnv, cwd: entrypointDirname, stdio: 'inherit' },
      );
    } catch (err) {
      console.log('failed to `go build`');
      throw err;
    }
  } else {
    const origianlMainGoContents = await readFile(
      path.join(__dirname, 'main.go'),
      'utf8',
    );
    const mainGoContents = origianlMainGoContents.replace(
      '__NOW_HANDLER_FUNC_NAME',
      handlerFunctionName,
    );
    // in order to allow the user to have `main.go`, we need our `main.go` to be called something else
    const mainGoFileName = 'main__now__go__.go';

    // Go doesn't like to build files in different directories,
    // so now we place `main.go` together with the user code
    await writeFile(path.join(entrypointDirname, mainGoFileName), mainGoContents);

    console.log('installing dependencies');
    // `go get` will look at `*.go` (note we set `cwd`), parse
    // the `import`s and download any packages that aren't part of the stdlib
    try {
      await execa(goBin, ['get'], {
        env: goEnv,
        cwd: entrypointDirname,
        stdio: 'inherit',
      });
    } catch (err) {
      console.log('failed to `go get`');
      throw err;
    }

    console.log('running go build...');
    try {
      await execa(
        goBin,
        [
          'build',
          '-o',
          path.join(outDir, 'handler'),
          path.join(entrypointDirname, mainGoFileName),
          downloadedFiles[entrypoint].fsPath,
        ],
        { env: goEnv, cwd: entrypointDirname, stdio: 'inherit' },
      );
    } catch (err) {
      console.log('failed to `go build`');
      throw err;
    }
  }

  const lambda = await createLambda({
    files: await glob('**', outDir),
    handler: 'handler',
    runtime: 'go1.x',
    environment: {},
  });

  return {
    [entrypoint]: lambda,
  };
};
