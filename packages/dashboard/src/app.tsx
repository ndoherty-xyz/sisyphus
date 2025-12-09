import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { spawn, ChildProcess } from "child_process";
import {
  getAttemptCounts,
  getDeliveryCounts,
  getE2ELatencyStats,
  getGlobalQueueDepth,
  isGlobalBackpressureActive,
  getShopQueueDepth,
  redis,
  ACTIVE_SHOP_QUEUES_KEY,
  getAllShops,
  clearMetrics,
} from "@sisyphus/shared";

// Types
type Shop = {
  id: string;
  name: string;
};

type LogEntry = {
  level: number;
  time: number;
  serviceName: string;
  msg: string;
  [key: string]: unknown;
};

type ProcessState = {
  status: "starting" | "running" | "stopped" | "error";
  logs: LogEntry[];
};

type Metrics = {
  attemptsTotal: number;
  attemptsSuccess: number;
  deliveriesSuccess: number;
  deliveriesDead: number;
  avgLatency: number;
  maxLatency: number;
  globalQueueDepth: number;
  globalBackpressure: boolean;
  perTenantDepths: Map<string, number>;
};

const MAX_LOGS = 15;
const METRICS_POLL_MS = 1000;

function levelToString(level: number): string {
  if (level <= 10) return "TRACE";
  if (level <= 20) return "DEBUG";
  if (level <= 30) return "INFO";
  if (level <= 40) return "WARN";
  if (level <= 50) return "ERROR";
  return "FATAL";
}

function levelToColor(level: number): string {
  if (level <= 20) return "gray";
  if (level <= 30) return "green";
  if (level <= 40) return "yellow";
  return "red";
}

function formatLog(log: LogEntry): string {
  const eventId = log["eventId"]
    ? `[${(log["eventId"] as string).slice(0, 8)}]`
    : "";

  // filter out meta fields, show everything else
  const metaFields = ["level", "time", "serviceName", "msg", "eventId"];
  const dataFields = Object.entries(log)
    .filter(([key]) => !metaFields.includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  const suffix = dataFields ? ` | ${dataFields}` : "";

  return `${eventId} ${log.msg}${suffix}`;
}

function LogPanel({
  title,
  logs,
  status,
}: {
  title: string;
  logs: LogEntry[];
  status: ProcessState["status"];
}) {
  const statusColor =
    status === "running" ? "green" : status === "error" ? "red" : "yellow";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
      flexShrink={1}
      flexBasis="50%"
    >
      <Box>
        <Text bold>{title}</Text>
        <Text> </Text>
        <Text color={statusColor}>[{status}]</Text>
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        marginBottom={1}
        overflow="hidden"
      >
        {logs.length === 0 ? (
          <Text color="gray">No logs yet...</Text>
        ) : (
          logs.slice(-MAX_LOGS).map((log, i) => (
            <Box key={i} flexDirection="row" gap={1}>
              <Box flexShrink={0} width={8}>
                <Text color={levelToColor(log.level)}>
                  {new Date(log.time).getHours()}:
                  {new Date(log.time).getMinutes()}:
                  {new Date(log.time).getSeconds()}
                </Text>
              </Box>
              <Box flexShrink={0} width={4}>
                <Text color={levelToColor(log.level)}>
                  {levelToString(log.level)}
                </Text>
              </Box>

              <Box>
                <Text color={levelToColor(log.level)} wrap="wrap">
                  {formatLog(log)}
                </Text>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function MetricsPanel({
  metrics,
  selectedShop,
}: {
  metrics: Metrics | null;
  selectedShop: Shop | null;
}) {
  if (!metrics) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        width={35}
      >
        <Text bold>METRICS</Text>
        <Text color="gray">Loading...</Text>
      </Box>
    );
  }

  const successRate =
    metrics.attemptsTotal > 0
      ? ((metrics.attemptsSuccess / metrics.attemptsTotal) * 100).toFixed(1)
      : "0.0";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width={35}
    >
      <Text bold>METRICS</Text>
      <Text> </Text>

      <Text bold color="cyan">
        Queue
      </Text>
      <Text>
        Depth: <Text color="yellow">{metrics.globalQueueDepth}</Text>
      </Text>
      <Text>
        Backpressure:{" "}
        <Text color={metrics.globalBackpressure ? "red" : "green"}>
          {metrics.globalBackpressure ? "ON" : "off"}
        </Text>
      </Text>
      <Text> </Text>

      <Text bold color="cyan">
        Attempts
      </Text>
      <Text>
        Total: <Text color="white">{metrics.attemptsTotal}</Text>
      </Text>
      <Text>
        Success rate: <Text color="green">{successRate}%</Text>
      </Text>
      <Text> </Text>

      <Text bold color="cyan">
        Deliveries
      </Text>
      <Text>
        Success: <Text color="green">{metrics.deliveriesSuccess}</Text>
      </Text>
      <Text>
        Dead: <Text color="red">{metrics.deliveriesDead}</Text>
      </Text>
      <Text> </Text>

      <Text bold color="cyan">
        Latency (e2e)
      </Text>
      <Text>
        Avg: <Text color="white">{metrics.avgLatency.toFixed(0)}ms</Text>
      </Text>
      <Text>
        Max: <Text color="white">{metrics.maxLatency.toFixed(0)}ms</Text>
      </Text>
      <Text> </Text>

      <Text bold color="cyan">
        Per-Tenant Depths
      </Text>
      {metrics.perTenantDepths.size === 0 ? (
        <Text color="gray">No active queues</Text>
      ) : (
        Array.from(metrics.perTenantDepths.entries()).map(([shopId, depth]) => (
          <Text
            key={shopId}
            color={selectedShop?.id === shopId ? "cyan" : "white"}
          >
            {shopId.slice(0, 8)}: {depth}
          </Text>
        ))
      )}
    </Box>
  );
}

export default function App() {
  // Process state
  const [worker1, setWorker1] = useState<ProcessState>({
    status: "starting",
    logs: [],
  });
  const [worker2, setWorker2] = useState<ProcessState>({
    status: "starting",
    logs: [],
  });
  const [drain, setDrain] = useState<ProcessState>({
    status: "starting",
    logs: [],
  });
  const [receiver, setReceiver] = useState<ProcessState>({
    status: "starting",
    logs: [],
  });
  const [producer, setProducer] = useState<ProcessState>({
    status: "starting",
    logs: [],
  });

  // Metrics state
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // Shop selection for producing events
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [selectedShopIndex, setSelectedShopIndex] = useState(0);
  const selectedShop = shops[selectedShopIndex] ?? null;

  // Process references for cleanup
  const processRefs = React.useRef<{
    worker1?: ChildProcess;
    worker2?: ChildProcess;
    drain?: ChildProcess;
    receiver?: ChildProcess;
  }>({});

  // Spawn a service and wire up log capture
  function spawnService(
    name: string,
    packageName: string,
    setProcessState: React.Dispatch<React.SetStateAction<ProcessState>>,
    extraEnv: Record<string, string> = {}
  ): ChildProcess {
    const proc = spawn("pnpm", ["--filter", packageName, "dev"], {
      cwd: process.cwd().replace("/packages/dashboard", ""), // go to monorepo root
      env: { ...process.env, FORCE_COLOR: "0", ...extraEnv }, // disable color codes in child
      stdio: ["ignore", "pipe", "pipe"], // stdin ignored, stdout/stderr piped
    });

    let buffer = "";

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line) as LogEntry;
            setProcessState((prev) => ({
              status: "running",
              logs: [...prev.logs.slice(-(MAX_LOGS * 2)), parsed],
            }));
          } catch {
            // non-JSON output (like pnpm startup messages), ignore
          }
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      // stderr often has startup messages, could log these differently
      const msg = data.toString().trim();
      if (msg && !msg.includes("WARN") && !msg.includes("deprecated")) {
        setProcessState((prev) => ({
          ...prev,
          logs: [
            ...prev.logs.slice(-(MAX_LOGS * 2)),
            {
              level: 50,
              time: Date.now(),
              serviceName: name,
              msg: `[stderr] ${msg}`,
            },
          ],
        }));
      }
    });

    proc.on("error", (err) => {
      setProcessState((prev) => ({
        status: "error",
        logs: [
          ...prev.logs,
          {
            level: 50,
            time: Date.now(),
            serviceName: name,
            msg: `Process error: ${err.message}`,
          },
        ],
      }));
    });

    proc.on("exit", (code) => {
      setProcessState((prev) => ({
        status: code === 0 ? "stopped" : "error",
        logs: [
          ...prev.logs,
          {
            level: code === 0 ? 30 : 50,
            time: Date.now(),
            serviceName: name,
            msg: `Exited with code ${code}`,
          },
        ],
      }));
    });

    setProcessState((prev) => ({ ...prev, status: "running" }));
    return proc;
  }

  function spawnProducer(args: string[]) {
    setProducer((prev) => ({ ...prev, status: "running" }));

    const proc = spawn("pnpm", ["--filter", "@sisyphus/producer", ...args], {
      cwd: process.cwd().replace("/packages/dashboard", ""),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line) as LogEntry;
            setProducer((prev) => ({
              ...prev,
              logs: [...prev.logs.slice(-(MAX_LOGS * 2)), parsed],
            }));
          } catch {
            // non-JSON, ignore
          }
        }
      }
    });

    proc.on("exit", () => {
      setProducer((prev) => ({ ...prev, status: "stopped" }));
    });
  }

  // Spawn processes on mount
  useEffect(() => {
    processRefs.current.receiver = spawnService(
      "receiver",
      "@sisyphus/receiver",
      setReceiver
    );

    // Small delay before spawning worker/drain to let receiver start
    const timeout = setTimeout(() => {
      processRefs.current.worker1 = spawnService(
        "worker-1",
        "@sisyphus/worker",
        setWorker1,
        { WORKER_ID: "1" }
      );
      processRefs.current.worker2 = spawnService(
        "worker-2",
        "@sisyphus/worker",
        setWorker2,
        { WORKER_ID: "2" }
      );
      processRefs.current.drain = spawnService(
        "drain",
        "@sisyphus/drain",
        setDrain
      );
    }, 1000);

    return () => {
      clearTimeout(timeout);
      processRefs.current.worker1?.kill();
      processRefs.current.worker2?.kill();
      processRefs.current.drain?.kill();
      processRefs.current.receiver?.kill();
    };
  }, []);

  // Poll metrics
  useEffect(() => {
    async function fetchMetrics() {
      try {
        const [
          attempts,
          deliveries,
          latency,
          globalDepth,
          backpressure,
          activeShops,
        ] = await Promise.all([
          getAttemptCounts(),
          getDeliveryCounts(),
          getE2ELatencyStats(),
          getGlobalQueueDepth(),
          isGlobalBackpressureActive(),
          redis.smembers(ACTIVE_SHOP_QUEUES_KEY),
        ]);

        // Get per-tenant depths
        const perTenantDepths = new Map<string, number>();
        for (const shopId of activeShops) {
          const depth = await getShopQueueDepth(shopId);
          perTenantDepths.set(shopId, depth);
        }

        setMetrics({
          attemptsTotal: attempts.total,
          attemptsSuccess: attempts.success,
          deliveriesSuccess: deliveries.success,
          deliveriesDead: deliveries.dead,
          avgLatency: latency.average || 0,
          maxLatency: latency.max || 0,
          globalQueueDepth: globalDepth,
          globalBackpressure: backpressure,
          perTenantDepths,
        });
      } catch (err) {
        // Redis not ready yet, ignore
      }
    }

    fetchMetrics();
    const interval = setInterval(fetchMetrics, METRICS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Load shops from DB on mount
  useEffect(() => {
    async function loadShops() {
      const allShops = await getAllShops();
      setShops(allShops.map((s) => ({ id: s.id, name: s.name })));
    }
    loadShops();
  }, []);

  // Handle keyboard input
  useInput((input, key) => {
    if (input === "q" || key.escape) {
      processRefs.current.worker1?.kill();
      processRefs.current.worker2?.kill();
      processRefs.current.drain?.kill();
      processRefs.current.receiver?.kill();
      clearMetrics().then(() => {
        process.exit(0);
      });
    }

    // Shop selection with number keys or up/down
    if (key.upArrow && shops.length > 0) {
      setSelectedShopIndex((prev) => (prev - 1 + shops.length) % shops.length);
    }
    if (key.downArrow && shops.length > 0) {
      setSelectedShopIndex((prev) => (prev + 1) % shops.length);
    }

    // Produce single event
    if (input === "p" && selectedShop) {
      spawnProducer(["dev", selectedShop.id, "1"]);
    }

    // Flood events
    if (input === "f" && selectedShop) {
      spawnProducer(["flood", selectedShop.id, "50"]);
    }
  });

  return (
    <Box flexDirection="column" height={process.stdout.rows - 1}>
      {/* Header */}
      <Box borderStyle="double" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          SISYPHUS WEBHOOK SYSTEM
        </Text>
      </Box>

      {/* Main content */}
      <Box flexGrow={1}>
        <MetricsPanel metrics={metrics} selectedShop={selectedShop} />
        <Box flexDirection="column" flexGrow={1}>
          <Box flexGrow={1} flexBasis="50%">
            <LogPanel
              title="WORKER 1"
              logs={worker1.logs}
              status={worker1.status}
            />
            <LogPanel
              title="WORKER 2"
              logs={worker2.logs}
              status={worker2.status}
            />
          </Box>
          <Box flexGrow={1} flexBasis="50%">
            <LogPanel
              title="PRODUCER"
              logs={producer.logs}
              status={producer.status}
            />
            <LogPanel title="DRAIN" logs={drain.logs} status={drain.status} />
            <LogPanel
              title="RECEIVER"
              logs={receiver.logs}
              status={receiver.status}
            />
          </Box>
        </Box>
      </Box>

      {/* Footer with controls */}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        justifyContent="space-between"
      >
        <Box>
          <Text color="gray">Shop: </Text>
          <Text color="cyan">{selectedShop?.name ?? "none"}</Text>
          <Text color="gray"> (↑↓ to select)</Text>
        </Box>
        <Box>
          <Text color="yellow">[p]</Text>
          <Text>roduce </Text>
          <Text color="yellow">[f]</Text>
          <Text>lood </Text>
          <Text color="yellow">[q]</Text>
          <Text>uit</Text>
        </Box>
      </Box>
    </Box>
  );
}
