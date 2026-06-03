const { getIO } = require("./io_connect");
const Logger = require("../utils/logger");

const clients = {};

function authSockets(io) {
  io.on("connection", (socket) => {
    // authentications
    socket.on("watch-accounts", async (data) => {
      const room = `${socket.project.code}/_auth`;
      addToClients({ room, client: socket.id });
    });

    socket.on("disconnect", () => {
      removeFromClients(socket.id);
    });

    //
  });
}

function addToClients({ room, client }) {
  if (!clients[room]) clients[room] = [];
  if (!clients[room].includes(client)) clients[room].push(client);
}

// Remove client from room
function removeFromClients(client) {
  for (const room in clients) {
    clients[room] = clients[room].filter((c) => c !== client);
    if (clients[room].length === 0) delete clients[room];
  }
}

function sendAuthSocketEvent({ projectCode, action, data }) {
  try {
    const room = `${projectCode}/_auth`;
    const socketIds = clients[room] || [];

    for (let i = 0; i < socketIds.length; i++) {
      const id = socketIds[i];
      getIO()
        .to(id)
        .emit(room, { [action]: data });
    }
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
  }
}

module.exports = {
  authSockets,
  sendAuthSocketEvent,
};
