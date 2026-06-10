"use client";

import {
  ChangeEvent,
  useDeferredValue,
  useMemo,
  useState,
  startTransition,
} from "react";

type LogLevel =
  | "emergency"
  | "alert"
  | "critical"
  | "error"
  | "warning"
  | "notice"
  | "info"
  | "debug"
  | "other";

type LogItem = {
  timestamp: string;
  environment: string;
  level: LogLevel;
  message: string;
};

type JsonRecord = Record<string, unknown>;

function getLogDate(timestamp: string) {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeLogString(value: string) {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function extractJsonBlocks(message: string) {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < message.length; index += 1) {
    const character = message[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === "\\") {
        isEscaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        start = index;
      }

      depth += 1;
      continue;
    }

    if (character === "}" && depth > 0) {
      depth -= 1;

      if (depth === 0 && start >= 0) {
        blocks.push(message.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

function formatValue(value: unknown) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function extractQuotedField(message: string, field: string) {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"`);
  const match = message.match(pattern);
  return match ? unescapeLogString(match[1]) : null;
}

function extractBooleanField(message: string, field: string) {
  const pattern = new RegExp(`"${field}"\\s*:\\s*(true|false)`, "i");
  const match = message.match(pattern);
  return match ? match[1].toLowerCase() === "true" : null;
}

function extractObjectFields(message: string, objectKey: string) {
  const keyIndex = message.indexOf(`"${objectKey}"`);

  if (keyIndex < 0) {
    return [];
  }

  const slice = message.slice(keyIndex);
  const stopIndexes = [
    slice.indexOf(',"trace"'),
    slice.indexOf("\n#0 "),
    slice.indexOf("(truncated...)"),
  ].filter((index) => index >= 0);
  const endIndex =
    stopIndexes.length > 0 ? Math.min(...stopIndexes) : Math.min(slice.length, 800);
  const objectSlice = slice.slice(0, endIndex);
  const fields = [...objectSlice.matchAll(/"([^"]+)"\s*:\s*("([^"]*)"|true|false|null|\d+)/g)];

  return fields
    .filter(([, fieldName]) => fieldName !== objectKey)
    .map(([, fieldName, rawValue, quotedValue]) => {
      const value = quotedValue ?? rawValue;
      return {
        key: fieldName,
        value: quotedValue ? unescapeLogString(value) : value,
      };
    });
}

function humanizeTrace(trace: string) {
  const frames = trace.split("\n").filter((line) => line.trim().startsWith("#"));
  const prioritizedFrames = frames.filter((line) => line.includes("/app/"));
  const selectedFrames = (prioritizedFrames.length > 0 ? prioritizedFrames : frames).slice(0, 4);

  if (selectedFrames.length === 0) {
    return [];
  }

  return selectedFrames.map((frame) => {
    const normalizedFrame = frame.replace("/var/www/html/", "");
    const match = normalizedFrame.match(/^(#\d+)\s+(.+?\.php)\((\d+)\):\s*(.*)$/);

    if (!match) {
      return `- ${normalizedFrame}`;
    }

    return `- ${match[1]} ${match[2]}:${match[3]} -> ${match[4]}`;
  });
}

function humanizeLogMessage(message: string) {
  const sections: string[] = [];
  const firstJsonIndex = message.indexOf("{");
  const firstLine = message.split("\n")[0] ?? "";
  const heading = (firstJsonIndex >= 0 ? message.slice(0, firstJsonIndex) : firstLine)
    .trim()
    .replace(/:\s*$/, "");
  const statusCode = message.match(/status code (\d{3})/i)?.[1];
  const parsedBlocks = extractJsonBlocks(message)
    .map((block) => {
      try {
        return JSON.parse(block) as unknown;
      } catch {
        return null;
      }
    })
    .filter((block): block is JsonRecord => isJsonRecord(block));

  const responsePayload =
    parsedBlocks.find((block) => "message" in block || "status" in block || "data" in block) ?? null;
  const tracePayload = parsedBlocks.find(
    (block) => typeof block.trace === "string"
  );
  const fallbackStatus = extractBooleanField(message, "status");
  const fallbackMessage = extractQuotedField(message, "message");
  const existingCowFields = extractObjectFields(message, "existing_cow");
  const dataFields = extractObjectFields(message, "data");
  const trace =
    (typeof tracePayload?.trace === "string" ? tracePayload.trace : null) ??
    message.match(/"trace":"([\s\S]*)"\s*$/)?.[1]?.replace(/\\n/g, "\n").replace(/\\"/g, '"');

  if (heading.length > 0) {
    sections.push(heading);
  }

  if (statusCode) {
    sections.push(`HTTP status: ${statusCode}`);
  }

  if (responsePayload) {
    if (typeof responsePayload.status === "boolean") {
      sections.push(`Request status: ${responsePayload.status ? "success" : "failed"}`);
    }

    if (typeof responsePayload.message === "string") {
      sections.push(`API message: ${responsePayload.message}`);
    }

    if (isJsonRecord(responsePayload.data)) {
      const dataLines: string[] = [];

      for (const [key, value] of Object.entries(responsePayload.data)) {
        if (isJsonRecord(value)) {
          dataLines.push(`${key.replaceAll("_", " ")}:`);

          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            dataLines.push(`- ${nestedKey.replaceAll("_", " ")}: ${formatValue(nestedValue)}`);
          }

          continue;
        }

        dataLines.push(`${key.replaceAll("_", " ")}: ${formatValue(value)}`);
      }

      if (dataLines.length > 0) {
        sections.push(`Data:\n${dataLines.join("\n")}`);
      }
    }
  }

  if (
    responsePayload &&
    typeof responsePayload.data !== "object" &&
    existingCowFields.length > 0
  ) {
    sections.push(
      `Existing cow:\n${existingCowFields
        .map(({ key, value }) => `- ${key.replaceAll("_", " ")}: ${value}`)
        .join("\n")}`
    );
  }

  if (
    responsePayload &&
    typeof responsePayload.data !== "object" &&
    existingCowFields.length === 0 &&
    dataFields.length > 0
  ) {
    sections.push(
      `Data:\n${dataFields
        .map(({ key, value }) => `- ${key.replaceAll("_", " ")}: ${value}`)
        .join("\n")}`
    );
  }

  if (!responsePayload && fallbackStatus !== null) {
    sections.push(`Request status: ${fallbackStatus ? "success" : "failed"}`);
  }

  if (!responsePayload && fallbackMessage) {
    sections.push(`API message: ${fallbackMessage}`);
  }

  if (!responsePayload && existingCowFields.length > 0) {
    sections.push(
      `Existing cow:\n${existingCowFields
        .map(({ key, value }) => `- ${key.replaceAll("_", " ")}: ${value}`)
        .join("\n")}`
    );
  }

  if (!responsePayload && existingCowFields.length === 0 && dataFields.length > 0) {
    sections.push(
      `Data:\n${dataFields
        .map(({ key, value }) => `- ${key.replaceAll("_", " ")}: ${value}`)
        .join("\n")}`
    );
  }

  if (message.includes("(truncated...)")) {
    sections.push("Note: part of the payload is truncated in the original log.");
  }

  if (trace) {
    const traceLines = humanizeTrace(trace);

    if (traceLines.length > 0) {
      sections.push(`Likely trace path:\n${traceLines.join("\n")}`);
    }
  }

  if (sections.length === 0) {
    return message;
  }

  return sections.join("\n\n");
}

const LOG_LEVELS: LogLevel[] = [
  "emergency",
  "alert",
  "critical",
  "error",
  "warning",
  "notice",
  "info",
  "debug",
  "other",
];

const LEVEL_STYLES: Record<LogLevel, string> = {
  emergency: "bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-400/30",
  alert: "bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-400/30",
  critical: "bg-red-500/15 text-red-100 ring-1 ring-inset ring-red-400/30",
  error: "bg-orange-500/15 text-orange-100 ring-1 ring-inset ring-orange-300/30",
  warning: "bg-amber-500/15 text-amber-100 ring-1 ring-inset ring-amber-300/30",
  notice: "bg-sky-500/15 text-sky-100 ring-1 ring-inset ring-sky-300/30",
  info: "bg-cyan-500/15 text-cyan-100 ring-1 ring-inset ring-cyan-300/30",
  debug: "bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-300/30",
  other: "bg-white/10 text-white/80 ring-1 ring-inset ring-white/15",
};

const LIGHT_LEVEL_STYLES: Record<LogLevel, string> = {
  emergency: "bg-rose-100 text-rose-700 ring-1 ring-inset ring-rose-200",
  alert: "bg-rose-100 text-rose-700 ring-1 ring-inset ring-rose-200",
  critical: "bg-red-100 text-red-700 ring-1 ring-inset ring-red-200",
  error: "bg-orange-100 text-orange-700 ring-1 ring-inset ring-orange-200",
  warning: "bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200",
  notice: "bg-sky-100 text-sky-700 ring-1 ring-inset ring-sky-200",
  info: "bg-cyan-100 text-cyan-700 ring-1 ring-inset ring-cyan-200",
  debug: "bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200",
  other: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200",
};

const SAMPLE_LOG = `[2026-05-22 09:12:14] production.ERROR: SQLSTATE[42S22]: Column not found: 1054 Unknown column 'profile_photo' in 'field list' {"userId":42}
#0 /var/www/app/Http/Controllers/ProfileController.php(88): Illuminate\\Database\\Connection->runQueryCallback()
#1 /var/www/app/vendor/laravel/framework/src/Illuminate/Routing/ControllerDispatcher.php(46): App\\Http\\Controllers\\ProfileController->update()
[2026-05-22 09:13:47] production.WARNING: Queue retry threshold reached for job ProcessInvoice {"job_id":"inv-2026-44"}
[2026-05-22 09:16:03] local.INFO: Nightly cleanup finished successfully {"duration_ms":1840}`;

function normalizeLevel(level: string): LogLevel {
  const normalized = level.toLowerCase() as LogLevel;
  return LOG_LEVELS.includes(normalized) ? normalized : "other";
}

function parseLaravelLog(content: string): LogItem[] {
  const entries = content
    .split(/\r?\n/)
    .reduce<string[]>((accumulator, line) => {
      const isNewEntry = /^\[[^\]]+\]\s+/.test(line);

      if (isNewEntry || accumulator.length === 0) {
        accumulator.push(line);
        return accumulator;
      }

      accumulator[accumulator.length - 1] += `\n${line}`;
      return accumulator;
    }, [])
    .filter((entry) => entry.trim().length > 0);

  return entries.flatMap((entry) => {
    const match = entry.match(/^\[(.*?)\]\s+([^.]+)\.(\w+):\s([\s\S]*)$/);

    if (!match) {
      return [];
    }

    return [
      {
        timestamp: match[1].trim(),
        environment: match[2].trim(),
        level: normalizeLevel(match[3]),
        message: match[4].trim(),
      },
    ];
  });
}

function formatLevel(level: LogLevel) {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function downloadLogsAsJson(logs: LogItem[]) {
  const blob = new Blob([JSON.stringify(logs, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "filtered-laravel-logs.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Page() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [search, setSearch] = useState("");
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | "all">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [rawInput, setRawInput] = useState("");
  const [humanizedRows, setHumanizedRows] = useState<Record<string, boolean>>({});
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }

    const savedTheme = window.localStorage.getItem("log-reader-theme");

    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme === "dark";
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const deferredSearch = useDeferredValue(search);
  const perPage = 8;
  const toggleTheme = () => {
    setIsDark((current) => {
      const next = !current;
      window.localStorage.setItem("log-reader-theme", next ? "dark" : "light");
      return next;
    });
  };
  const toggleHumanizedRow = (rowKey: string) => {
    setHumanizedRows((current) => ({
      ...current,
      [rowKey]: !current[rowKey],
    }));
  };

  const ingestContent = (content: string) => {
    const parsedLogs = parseLaravelLog(content);

    startTransition(() => {
      setLogs(parsedLogs);
      setHumanizedRows({});
      setCurrentPage(1);
    });
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    ingestContent(text);
    setRawInput(text);
  };

  const filteredLogs = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    return logs.filter((log) => {
      const logDate = getLogDate(log.timestamp);
      const matchesLevel = selectedLevel === "all" || log.level === selectedLevel;
      const matchesFromDate = fromDate.length === 0 || (logDate.length > 0 && logDate >= fromDate);
      const matchesToDate = toDate.length === 0 || (logDate.length > 0 && logDate <= toDate);
      const matchesSearch =
        query.length === 0 ||
        log.message.toLowerCase().includes(query) ||
        log.level.toLowerCase().includes(query) ||
        log.timestamp.toLowerCase().includes(query) ||
        log.environment.toLowerCase().includes(query);

      return matchesLevel && matchesFromDate && matchesToDate && matchesSearch;
    });
  }, [deferredSearch, fromDate, logs, selectedLevel, toDate]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / perPage));

  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * perPage;
    return filteredLogs.slice(start, start + perPage);
  }, [currentPage, filteredLogs]);

  const stats = useMemo(() => {
    const levelCounts = LOG_LEVELS.reduce<Record<LogLevel, number>>((accumulator, level) => {
      accumulator[level] = 0;
      return accumulator;
    }, {} as Record<LogLevel, number>);

    for (const log of logs) {
      levelCounts[log.level] += 1;
    }

    return {
      total: logs.length,
      visible: filteredLogs.length,
      errors:
        levelCounts.error +
        levelCounts.critical +
        levelCounts.alert +
        levelCounts.emergency,
      environments: new Set(logs.map((log) => log.environment)).size,
      levelCounts,
    };
  }, [filteredLogs.length, logs]);

  const hasLogs = logs.length > 0;
  const levelStyles = isDark ? LEVEL_STYLES : LIGHT_LEVEL_STYLES;
  const ui = isDark
    ? {
        page:
          "bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_28%),radial-gradient(circle_at_85%_10%,_rgba(56,189,248,0.18),_transparent_28%),linear-gradient(180deg,_#08111f_0%,_#111827_40%,_#050816_100%)] text-slate-100",
        grid:
          "bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] opacity-20",
        hero: "border-white/10 bg-slate-950/55 shadow-slate-950/35",
        side: "border-white/10 bg-slate-950/60 shadow-slate-950/35",
        mainCard: "border-white/10 bg-white/8 shadow-slate-950/35",
        card: "border-white/10 bg-white/6",
        title: "text-white",
        text: "text-slate-300",
        muted: "text-slate-400",
        dim: "text-slate-500",
        pill: "border-white/10 text-slate-300",
        input:
          "border-white/12 bg-slate-950/65 text-white placeholder:text-slate-500 focus:border-cyan-300/50 focus:ring-cyan-300/15",
        labelUpload: "border-cyan-300/25 bg-cyan-300/6 hover:border-cyan-200/45 hover:bg-cyan-300/10",
        uploadLabelText: "text-cyan-100",
        tableWrap: "border-white/10 bg-slate-950/65",
        tableHead: "bg-slate-950/95 text-slate-400 border-white/10",
        tableRow: "border-white/8 hover:bg-white/5",
        tableText: "text-slate-300",
        message: "text-slate-100",
        emptyPill: "border-white/10 bg-white/8 text-slate-400",
        buttonGhost: "border-white/12 text-white hover:bg-white/8",
        counter: "border-white/10 bg-slate-950/50 text-slate-300",
        counterText: "text-white",
      }
    : {
        page:
          "bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.16),_transparent_28%),radial-gradient(circle_at_85%_10%,_rgba(14,165,233,0.12),_transparent_30%),linear-gradient(180deg,_#fcfcfd_0%,_#f3f7fb_42%,_#edf2f7_100%)] text-slate-900",
        grid:
          "bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.035)_1px,transparent_1px)] opacity-60",
        hero: "border-slate-200/80 bg-white/88 shadow-slate-300/30",
        side: "border-slate-200/80 bg-white/92 shadow-slate-300/25",
        mainCard: "border-slate-200/80 bg-white/90 shadow-slate-300/25",
        card: "border-slate-200 bg-slate-50/90",
        title: "text-slate-950",
        text: "text-slate-700",
        muted: "text-slate-600",
        dim: "text-slate-500",
        pill: "border-slate-200 text-slate-600",
        input:
          "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-sky-400/70 focus:ring-sky-200",
        labelUpload: "border-sky-200 bg-sky-50/80 hover:border-sky-300 hover:bg-sky-50",
        uploadLabelText: "text-sky-700",
        tableWrap: "border-slate-200/80 bg-white/95",
        tableHead: "bg-slate-50/95 text-slate-500 border-slate-200/90",
        tableRow: "border-slate-200/70 hover:bg-slate-50/90",
        tableText: "text-slate-700",
        message: "text-slate-900",
        emptyPill: "border-slate-200 bg-slate-100 text-slate-500",
        buttonGhost: "border-slate-200 text-slate-800 hover:bg-slate-100",
        counter: "border-slate-200 bg-slate-50 text-slate-600",
        counterText: "text-slate-900",
      };

  return (
    <main className={`relative min-h-screen overflow-hidden transition-colors ${ui.page}`}>
      <div
        className={`pointer-events-none absolute inset-0 bg-[size:72px_72px] transition-opacity ${ui.grid}`}
      />

      <div className="relative flex w-full flex-col gap-4 px-1.5 py-4 sm:px-2 lg:px-3 lg:py-5">
        <section
          className={`rounded-[1.5rem] border px-4 py-4 shadow-2xl backdrop-blur transition-colors md:px-5 ${ui.hero}`}
        >
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-4xl">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-amber-300/30 bg-amber-300/12 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-amber-100">
                  Laravel Log Reader
                </span>
                <span className={`rounded-full border px-3 py-1 text-[11px] ${ui.pill}`}>
                  multiline parsing enabled
                </span>
              </div>

              <h1 className={`font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight sm:text-4xl ${ui.title}`}>
                Review logs in a workspace that prioritizes scanning, not decoration.
              </h1>
              <p className={`mt-2 max-w-3xl text-sm leading-6 sm:text-base ${ui.text}`}>
                Upload or paste Laravel logs, keep stack traces intact, filter by level,
                and inspect results in a denser full-width table.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:min-w-[42rem]">
              <div className={`rounded-xl border px-3 py-3 ${ui.card}`}>
                <p className={`text-[11px] uppercase tracking-[0.18em] ${ui.dim}`}>Entries</p>
                <p className={`mt-1 text-2xl font-semibold ${ui.title}`}>{stats.total}</p>
              </div>
              <div className={`rounded-xl border px-3 py-3 ${ui.card}`}>
                <p className={`text-[11px] uppercase tracking-[0.18em] ${ui.dim}`}>Visible</p>
                <p className={`mt-1 text-2xl font-semibold ${ui.title}`}>{stats.visible}</p>
              </div>
              <div className={`rounded-xl border px-3 py-3 ${ui.card}`}>
                <p className={`text-[11px] uppercase tracking-[0.18em] ${ui.dim}`}>Errors</p>
                <p className={`mt-1 text-2xl font-semibold ${ui.title}`}>{stats.errors}</p>
              </div>
              <div className={`rounded-xl border px-3 py-3 ${ui.card}`}>
                <p className={`text-[11px] uppercase tracking-[0.18em] ${ui.dim}`}>Environments</p>
                <p className={`mt-1 text-2xl font-semibold ${ui.title}`}>{stats.environments}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className={`rounded-[1.5rem] border p-4 shadow-2xl backdrop-blur transition-colors ${ui.side}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className={`font-[family-name:var(--font-display)] text-xl ${ui.title}`}>
                  Ingest
                </h2>
                <p className={`mt-1 text-sm ${ui.muted}`}>Load a file or paste raw output.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setRawInput(SAMPLE_LOG);
                  ingestContent(SAMPLE_LOG);
                }}
                className={`rounded-full px-3 py-2 text-xs font-semibold transition ${
                  isDark
                    ? "border border-amber-300/25 bg-amber-300/10 text-amber-100 hover:bg-amber-300/16"
                    : "border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                }`}
              >
                Sample
              </button>
            </div>

            <label className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-7 text-center transition ${ui.labelUpload}`}>
              <span className={`text-[11px] uppercase tracking-[0.22em] ${ui.uploadLabelText}`}>File upload</span>
              <span className={`mt-2 text-base font-semibold ${ui.title}`}>Choose `.log` or `.txt`</span>
              <span className={`mt-1 text-xs ${ui.muted}`}>Processed locally in your browser.</span>
              <input
                type="file"
                accept=".log,.txt"
                onChange={handleFileUpload}
                className="sr-only"
              />
            </label>

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className={`text-[11px] uppercase tracking-[0.18em] ${ui.dim}`}>Raw input</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setLogs([]);
                    setRawInput("");
                    setSearch("");
                    setSelectedLevel("all");
                    setFromDate("");
                    setToDate("");
                    setHumanizedRows({});
                    setCurrentPage(1);
                  }}
                  className={`rounded-full border px-3 py-2 text-xs font-semibold transition ${ui.buttonGhost}`}
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => ingestContent(rawInput)}
                  disabled={rawInput.trim().length === 0}
                  className="rounded-full bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Parse
                </button>
              </div>
            </div>

            <textarea
              value={rawInput}
              onChange={(event) => setRawInput(event.target.value)}
              placeholder="Paste your Laravel log entries here..."
              className={`mt-2 h-72 w-full rounded-2xl border px-3 py-3 font-mono text-[13px] leading-5 outline-none transition focus:ring-2 focus:ring-amber-300/20 ${ui.input}`}
            />
          </div>

          <div className={`rounded-[1.5rem] border p-4 shadow-2xl backdrop-blur transition-colors ${ui.mainCard}`}>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className={`font-[family-name:var(--font-display)] text-xl ${ui.title}`}>
                  Log explorer
                </h2>
                <p className={`mt-1 text-sm ${ui.muted}`}>
                  The table is the primary workspace now: denser rows, wider message column, less dead space.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={toggleTheme}
                  className={`rounded-full border px-3 py-2 text-sm font-semibold transition ${ui.buttonGhost}`}
                >
                  {isDark ? "Light mode" : "Dark mode"}
                </button>
                <button
                  type="button"
                  onClick={() => downloadLogsAsJson(filteredLogs)}
                  disabled={filteredLogs.length === 0}
                  className={`rounded-full border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${ui.buttonGhost}`}
                >
                  Export JSON
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_180px_160px_160px_auto]">
              <input
                type="text"
                placeholder="Search message, stack trace, timestamp, environment..."
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setCurrentPage(1);
                }}
                className={`w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 ${ui.input}`}
              />

              <select
                value={selectedLevel}
                onChange={(event) => {
                  setSelectedLevel(event.target.value as LogLevel | "all");
                  setCurrentPage(1);
                }}
                className={`rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 ${ui.input}`}
              >
                <option value="all">All levels</option>
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {formatLevel(level)}
                  </option>
                ))}
              </select>

              <input
                type="date"
                value={fromDate}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  setCurrentPage(1);
                }}
                className={`rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 ${ui.input}`}
              />

              <input
                type="date"
                value={toDate}
                onChange={(event) => {
                  setToDate(event.target.value);
                  setCurrentPage(1);
                }}
                className={`rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 ${ui.input}`}
              />

              <div className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-sm xl:justify-center ${ui.counter}`}>
                <span className={`${ui.dim} xl:hidden`}>Matches</span>
                <span className={`font-semibold ${ui.counterText}`}>{filteredLogs.length}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {LOG_LEVELS.map((level) => (
                <span
                  key={level}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${levelStyles[level]}`}
                >
                  {formatLevel(level)} {stats.levelCounts[level]}
                </span>
              ))}
            </div>

            <div className={`mt-4 overflow-hidden rounded-2xl border ${ui.tableWrap}`}>
              {hasLogs ? (
                <div className="overflow-auto">
                  <table className="min-w-full table-fixed border-collapse">
                    <thead className={`sticky top-0 z-10 backdrop-blur ${ui.tableHead}`}>
                      <tr className={`border-b text-left text-[11px] uppercase tracking-[0.18em] ${ui.tableHead}`}>
                        <th className="w-[170px] px-3 py-3 font-semibold">Time</th>
                        <th className="w-[110px] px-3 py-3 font-semibold">Env</th>
                        <th className="w-[110px] px-3 py-3 font-semibold">Level</th>
                        <th className="px-3 py-3 font-semibold">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedLogs.map((log, index) => (
                        <tr
                          key={`${log.timestamp}-${index}`}
                          className={`border-b align-top transition ${ui.tableRow}`}
                        >
                          <td className={`px-3 py-3 font-mono text-[12px] leading-5 ${ui.tableText}`}>
                            {log.timestamp}
                          </td>
                          <td className={`px-3 py-3 text-sm ${ui.tableText}`}>{log.environment}</td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${levelStyles[log.level]}`}
                            >
                              {formatLevel(log.level)}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            {(() => {
                              const rowKey = `${log.timestamp}-${index}`;
                              const isHumanized = humanizedRows[rowKey] === true;

                              return (
                                <div className="relative">
                                  <button
                                    type="button"
                                    onClick={() => toggleHumanizedRow(rowKey)}
                                    className={`absolute right-0 top-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${ui.buttonGhost}`}
                                  >
                                    {isHumanized ? "Raw" : "Humanize"}
                                  </button>

                                  <pre
                                    className={`pr-24 whitespace-pre-wrap break-words text-[13px] leading-5 ${
                                      isHumanized ? `${ui.text} font-sans` : `${ui.message} font-mono`
                                    }`}
                                  >
                                    {isHumanized ? humanizeLogMessage(log.message) : log.message}
                                  </pre>
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center">
                  <div className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] ${ui.emptyPill}`}>
                    Waiting for input
                  </div>
                  <h3 className={`mt-4 font-[family-name:var(--font-display)] text-2xl ${ui.title}`}>
                    No logs loaded yet
                  </h3>
                  <p className={`mt-2 max-w-md text-sm leading-6 ${ui.muted}`}>
                    Add a file or paste raw log content to start scanning entries.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className={`text-sm ${ui.muted}`}>
                Showing <span className={ui.title}>{paginatedLogs.length}</span> of{" "}
                <span className={ui.title}>{filteredLogs.length}</span> matching entries
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((page) => page - 1)}
                  className={`rounded-full border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${ui.buttonGhost}`}
                >
                  Prev
                </button>
                <span className={`min-w-24 text-center text-sm ${ui.text}`}>
                  Page {Math.min(currentPage, totalPages)} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((page) => page + 1)}
                  className={`rounded-full border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${ui.buttonGhost}`}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
