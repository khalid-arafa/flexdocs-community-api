/**
 * Real-MongoDB provisioning for the integration suite.
 *
 * Every other test file in this repo mocks src/core/db_service, so nothing was
 * ever executed against a real query planner. This module hands the integration
 * suite an actual mongod, trying each strategy in turn and degrading to a clean
 * SKIP (never a failure) when the machine has no way to run one — CI runners
 * without network access or a Docker socket must still go green.
 *
 * Strategy order (first one that works wins):
 *   1. MONGODB_TEST_URI          — an operator-supplied server, used verbatim.
 *   2. mongodb-memory-server     — replica set, so transactions + change
 *                                  streams are available. Needs the mongod
 *                                  binary (cached under node_modules/.cache or
 *                                  ~/.cache/mongodb-binaries after first run).
 *   3. docker                    — ephemeral `mongo` container, replica set
 *                                  initiated on a random host port.
 *   4. local mongod              — 127.0.0.1:27017 if something answers there.
 *                                  Standalone: no transactions/change streams.
 *
 * Callers get { uri, replicaSet, strategy, stop() } or null when nothing works.
 */

const { execFile, execFileSync } = require("child_process");
const net = require("net");
const os = require("os");

const DOCKER_IMAGE = process.env.MONGODB_TEST_DOCKER_IMAGE || "mongo:7";
const DOCKER_CONTAINER = `flexdocs-itest-${process.pid}-${Date.now()}`;

// A cold mongodb-memory-server run has to download ~120MB of mongod before it
// can start, so the first-run budget is generous; the cached path takes <1s.
const MMS_TIMEOUT_MS = Number(process.env.MONGODB_TEST_BOOT_TIMEOUT_MS || 240_000);
const DOCKER_TIMEOUT_MS = 90_000;

function run(cmd, args, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ error, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

function commandExists(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resolves true if something is listening on host:port within `timeoutMs`. */
function portIsOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Strategy 1 — operator-supplied URI
// ---------------------------------------------------------------------------
async function tryExplicitUri(notes) {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) return null;
  notes.push("MONGODB_TEST_URI is set — using it verbatim");
  return {
    uri,
    // Assume a replica set only if the URI says so; a standalone server makes
    // the transaction/change-stream tests skip rather than fail.
    replicaSet: /replicaSet=/.test(uri),
    strategy: "explicit-uri",
    async stop() {},
  };
}

// ---------------------------------------------------------------------------
// Strategy 2 — mongodb-memory-server (preferred)
// ---------------------------------------------------------------------------
async function tryMemoryServer(notes) {
  let MongoMemoryReplSet;
  try {
    ({ MongoMemoryReplSet } = require("mongodb-memory-server"));
  } catch (err) {
    notes.push(`mongodb-memory-server not installed (${err.code || err.message})`);
    return null;
  }

  // A single-node replica set is enough for transactions and change streams and
  // starts far faster than a 3-node set.
  try {
    const replSet = await Promise.race([
      MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: "wiredTiger" },
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`memory-server did not start in ${MMS_TIMEOUT_MS}ms`)),
          MMS_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    notes.push("mongodb-memory-server replica set started");
    return {
      uri: replSet.getUri(),
      replicaSet: true,
      strategy: "mongodb-memory-server",
      async stop() {
        await replSet.stop({ doCleanup: true, force: true });
      },
    };
  } catch (err) {
    // Almost always a blocked binary download (no network / proxy / musl libc).
    notes.push(`mongodb-memory-server unavailable: ${String(err.message).slice(0, 300)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 3 — ephemeral docker container
// ---------------------------------------------------------------------------
async function stopDockerContainer(name) {
  await run("docker", ["rm", "-f", name], 60_000);
}

async function tryDocker(notes) {
  if (!commandExists("docker")) {
    notes.push("docker binary not found");
    return null;
  }
  const ping = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 15_000);
  if (ping.error) {
    notes.push("docker daemon not reachable");
    return null;
  }

  // -P publishes 27017 on a random free host port, so parallel runs never clash.
  const started = await run(
    "docker",
    ["run", "-d", "--name", DOCKER_CONTAINER, "-P", DOCKER_IMAGE, "--replSet", "rs0", "--bind_ip_all"],
    DOCKER_TIMEOUT_MS,
  );
  if (started.error) {
    notes.push(`docker run failed: ${(started.stderr || started.error.message).slice(0, 200)}`);
    await stopDockerContainer(DOCKER_CONTAINER);
    return null;
  }

  const portInfo = await run("docker", ["port", DOCKER_CONTAINER, "27017"], 15_000);
  const match = /(?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/.exec(portInfo.stdout);
  if (!match) {
    notes.push("could not read published docker port");
    await stopDockerContainer(DOCKER_CONTAINER);
    return null;
  }
  const port = Number(match[1]);

  // Wait for mongod to accept connections, then initiate the replica set.
  const deadline = Date.now() + DOCKER_TIMEOUT_MS;
  let up = false;
  while (Date.now() < deadline) {
    if (await portIsOpen("127.0.0.1", port)) {
      up = true;
      break;
    }
  }
  if (!up) {
    notes.push("docker mongo never opened its port");
    await stopDockerContainer(DOCKER_CONTAINER);
    return null;
  }

  const initiate = await run(
    "docker",
    [
      "exec",
      DOCKER_CONTAINER,
      "mongosh",
      "--quiet",
      "--eval",
      'try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch (e) { print(e.message) }',
    ],
    60_000,
  );
  if (initiate.error) {
    notes.push("rs.initiate failed inside docker container");
    await stopDockerContainer(DOCKER_CONTAINER);
    return null;
  }

  // Poll until the node reports itself writable primary.
  const primaryDeadline = Date.now() + 60_000;
  let primary = false;
  while (Date.now() < primaryDeadline) {
    const hello = await run(
      "docker",
      ["exec", DOCKER_CONTAINER, "mongosh", "--quiet", "--eval", "print(db.hello().isWritablePrimary)"],
      15_000,
    );
    if (/true/.test(hello.stdout)) {
      primary = true;
      break;
    }
  }
  if (!primary) {
    notes.push("docker mongo replica set never elected a primary");
    await stopDockerContainer(DOCKER_CONTAINER);
    return null;
  }

  notes.push(`docker ${DOCKER_IMAGE} replica set started on port ${port}`);
  return {
    // directConnection keeps the driver from chasing the replica-set member's
    // advertised host ("127.0.0.1:27017"), which is the CONTAINER's address.
    uri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
    replicaSet: true,
    strategy: "docker",
    async stop() {
      await stopDockerContainer(DOCKER_CONTAINER);
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy 4 — a mongod already running locally
// ---------------------------------------------------------------------------
async function tryLocalMongod(notes) {
  const port = Number(process.env.MONGODB_TEST_LOCAL_PORT || 27017);
  if (!(await portIsOpen("127.0.0.1", port))) {
    notes.push(`nothing listening on 127.0.0.1:${port}`);
    return null;
  }
  notes.push(`reusing local mongod on 127.0.0.1:${port} (assumed standalone)`);
  return {
    uri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
    replicaSet: false,
    strategy: "local-mongod",
    async stop() {},
  };
}

/**
 * Boots a real MongoDB by whichever strategy works on this machine.
 * @returns {Promise<{uri, replicaSet, strategy, notes, stop} | null>}
 */
async function startMongoForTests() {
  const notes = [];

  // Explicit opt-out, for a CI job that wants the unit suite's guarantees
  // without provisioning a database. Skips straight to the SKIP path.
  if (process.env.MONGODB_TEST_DISABLE === "1") {
    return null;
  }

  const strategies = [tryExplicitUri, tryMemoryServer, tryDocker, tryLocalMongod];

  for (const strategy of strategies) {
    let server = null;
    try {
      server = await strategy(notes);
    } catch (err) {
      notes.push(`${strategy.name} threw: ${String(err.message).slice(0, 200)}`);
    }
    if (server) return { ...server, notes };
  }

  notes.push(`platform=${os.platform()} arch=${os.arch()}`);
  return null;
}

module.exports = { startMongoForTests };
