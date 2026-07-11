const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const db = require("./db");

const server = new Server(
  {
    name: "greenhouse-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_full_greenhouse_report",
        description: "جلب تقرير كامل وشامل عن حالة الدفيئة والحساسات والمشغلات",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_full_greenhouse_report") {
    const sql = `SELECT t.*, s.*, a.* FROM telemetry_logs t 
                 JOIN sensors_data s ON t.id = s.log_id 
                 JOIN actuators_state a ON t.id = a.log_id 
                 ORDER BY t.id DESC LIMIT 1`;

    return new Promise((resolve, reject) => {
      db.query(sql, (err, results) => {
        if (err) reject(err);
        // نرسل البيانات كما هي ليقوم الذكاء الاصطناعي بتحليلها
        resolve({
          content: [{ type: "text", text: JSON.stringify(results[0]) }],
        });
      });
    });
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
