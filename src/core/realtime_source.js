/**
 * Which mechanism is currently producing realtime events.
 *
 * Deliberately a tiny module with no imports: both the change-stream driver
 * (core/change_streams.js) and the fan-out it feeds (sockets/db.sockets.js)
 * need to agree on this, and putting the state in either of them would make
 * them require each other in a cycle.
 *
 * There are two sources and they must never both fire for the same write:
 *
 *   emit-after-write  — the default, and the only source on standalone
 *                       MongoDB. Route handlers call the fan-out directly
 *                       after a successful write.
 *   change streams    — opt-in per project AND only where the deployment can
 *                       support them. Sees writes made outside the API and
 *                       survives a crash between the write and the emit,
 *                       neither of which emit-after-write can do.
 *
 * When change streams are running for a project, route-originated pushes for
 * that project's document collections are suppressed, so the change stream is
 * the single source of truth rather than a second voice.
 */

let running = false;

/** Called by the change-stream driver as it starts and stops. */
function setChangeStreamsRunning(value) {
  running = Boolean(value);
}

function areChangeStreamsRunning() {
  return running;
}

/**
 * True when this project's document events come from the change stream, and
 * route handlers must therefore stay quiet.
 *
 * Both halves matter: the driver has to actually be running (a standalone
 * deployment, or one where the stream died, must fall back to emit-after-write
 * rather than going silent), and the project has to have opted in.
 */
function changeStreamsActiveFor(project) {
  return running && Boolean(project && project.realtimeChangeStreams);
}

module.exports = {
  setChangeStreamsRunning,
  areChangeStreamsRunning,
  changeStreamsActiveFor,
};
