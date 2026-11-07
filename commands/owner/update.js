const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

const PROJECT_ROOT = process.env.CODEX_PROJECT_ROOT || path.join(__dirname, "../..");
const VERSION_FILE = path.join(PROJECT_ROOT, ".version");
const VARS_FILE = path.join(PROJECT_ROOT, "database", "variables.json");

const SKIP = [
  "node_modules",
  "session",
  // plugins NOT skipped — marketplace.js and other repo plugins must update via .update now
  ".git",
  ".env",
  "config.env",
  "config.json",
  "database",
  "media",
  "auth_info_baileys",
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Default to THIS fork so panel deploys stay on CodexABQ/CODEX-AI.
// Override anytime with UPDATE_REPO / .setvar / config.json.
const _HC_OWNER = "CodexABQ";
const _HC_REPO = "CODEX-AI";
const _HC_BRANCH = "main";

function getCfg(bot) {
  const vars = readJson(VARS_FILE);
  const repoFull =
    vars.UPDATE_REPO ||
    bot?.config?.UPDATE_REPO ||
    process.env.UPDATE_REPO ||
    `${_HC_OWNER}/${_HC_REPO}`;

  const [ownerFromRepo, repoFromRepo] = String(repoFull).includes("/")
    ? repoFull.split("/")
    : [
        vars.UPDATE_OWNER ||
          bot?.config?.UPDATE_OWNER ||
          process.env.UPDATE_OWNER ||
          _HC_OWNER,
        vars.UPDATE_NAME ||
          vars.UPDATE_REPO_NAME ||
          bot?.config?.UPDATE_NAME ||
          bot?.config?.UPDATE_REPO_NAME ||
          process.env.UPDATE_NAME ||
          process.env.UPDATE_REPO_NAME ||
          _HC_REPO,
      ];

  const cfg = {
    owner: ownerFromRepo || _HC_OWNER,
    repo: repoFromRepo || _HC_REPO,
    branch:
      vars.UPDATE_BRANCH ||
      bot?.config?.UPDATE_BRANCH ||
      process.env.UPDATE_BRANCH ||
      _HC_BRANCH,
    token:
      vars.UPDATE_TOKEN ||
      bot?.config?.UPDATE_TOKEN ||
      process.env.UPDATE_TOKEN ||
      "",
  };

  if (!cfg.owner || !cfg.repo) {
    throw new Error(
      "Update repo is not configured. Set UPDATE_REPO=owner/repo or UPDATE_OWNER and UPDATE_NAME.",
    );
  }
  return cfg;
}

function ghHeaders(cfg, raw = false) {
  const h = {
    "User-Agent": "CODEX-AI-Updater",
    Accept: raw
      ? "application/vnd.github.v3.raw"
      : "application/vnd.github.v3+json",
  };
  if (cfg.token) h.Authorization = `token ${cfg.token}`;
  return h;
}

async function reqJson(cfg, url) {
  const res = await axios.get(url, {
    timeout: 30000,
    headers: ghHeaders(cfg),
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    const msg = res.data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.data;
}

async function reqBuffer(cfg, url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 45000,
    headers: ghHeaders(cfg, true),
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  return Buffer.from(res.data);
}

function isSkipped(file) {
  const norm = path.normalize(file).replace(/\\/g, "/");
  return SKIP.some((item) => {
    const skip = path.normalize(item).replace(/\\/g, "/");
    return (
      norm === skip ||
      norm.startsWith(skip + "/") ||
      norm.includes("/" + skip + "/")
    );
  });
}

async function currentSha(cfg) {
  try {
    const saved = (await fs.readFile(VERSION_FILE, "utf8")).trim();
    if (saved) return saved;
  } catch {}

  const commits = await reqJson(
    cfg,
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=2`,
  );
  const sha = commits.length > 1 ? commits[1].sha : commits[0]?.sha;
  if (!sha) throw new Error("Could not detect current update version.");
  await fs.writeFile(VERSION_FILE, sha);
  return sha;
}

async function latestSha(cfg) {
  const latest = await reqJson(
    cfg,
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`,
  );
  return latest;
}

async function checkUpdates(cfg) {
  const curr = await currentSha(cfg);
  const latest = await latestSha(cfg);
  if (curr === latest.sha) {
    return { upToDate: true, curr, latest: latest.sha };
  }

  const compare = await reqJson(
    cfg,
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/compare/${curr}...${latest.sha}`,
  );

  const commits = (compare.commits || []).map((c) => ({
    hash: c.sha.slice(0, 8),
    msg: (c.commit?.message || "").split("\n")[0],
    date: c.commit?.author?.date
      ? new Date(c.commit.author.date).toISOString().slice(0, 10)
      : "",
  }));

  return {
    upToDate: false,
    curr: curr.slice(0, 8),
    latest: latest.sha.slice(0, 8),
    totalCommits: compare.total_commits || commits.length,
    commits: commits.reverse(),
  };
}

async function applyUpdate(cfg) {
  const curr = await currentSha(cfg);
  const latest = await latestSha(cfg);

  if (curr === latest.sha) {
    return { upToDate: true, curr: curr.slice(0, 8), latest: latest.sha.slice(0, 8) };
  }

  const compare = await reqJson(
    cfg,
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/compare/${curr}...${latest.sha}`,
  );

  const commits = (compare.commits || []).map((c) => ({
    hash: c.sha.slice(0, 8),
    msg: (c.commit?.message || "").split("\n")[0],
  }));

  const files = compare.files || [];
  const updated = [];
  const removed = [];
  const skipped = [];
  const failed = [];
  let needRestart = false;
  let commandOnly = true;

  for (const f of files) {
    const name = f.filename;
    if (isSkipped(name)) {
      skipped.push(name);
      continue;
    }

    if (f.status === "removed") {
      try {
        const target = path.join(PROJECT_ROOT, name);
        if (await fs.pathExists(target)) {
          await fs.remove(target);
          removed.push(name);
        }
      } catch (e) {
        failed.push(`${name} (${e.message})`);
      }
      continue;
    }

    try {
      const url = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${latest.sha}/${name}`;
      const buf = await reqBuffer(cfg, url);
      const target = path.join(PROJECT_ROOT, name);
      await fs.ensureDir(path.dirname(target));
      await fs.writeFile(target, buf);
      updated.push(name);

      if (
        name === "index.js" ||
        name === "app.js" ||
        name.startsWith("lib/") ||
        name === "package.json"
      ) {
        needRestart = true;
        commandOnly = false;
      }
      if (!name.startsWith("commands/") && !name.startsWith("plugins/")) {
        commandOnly = false;
      }
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }

  await fs.writeFile(VERSION_FILE, latest.sha);

  return {
    ok: failed.length === 0,
    upToDate: false,
    curr: curr.slice(0, 8),
    latest: latest.sha.slice(0, 8),
    commits: commits.reverse(),
    updated,
    removed,
    skipped,
    failed,
    needRestart,
    commandOnly,
  };
}

function shortList(items, limit = 8) {
  if (!items?.length) return "none";
  const shown = items.slice(0, limit).join("\n");
  const more =
    items.length > limit ? `\n... and ${items.length - limit} more` : "";
  return shown + more;
}

module.exports = {
  _helpers: { getCfg, checkUpdates, applyUpdate, VERSION_FILE },
  name: "update",
  aliases: ["upd", "upgrade"],
  category: "owner",
  reactions: { start: "🔐" },
  description: "Update local files from GitHub API",
  ownerOnly: true,

  async execute(bot, m, args) {
    const sub = (args[0] || "").toLowerCase();
    const cfg = getCfg(bot);

    try {
      if (!sub || sub === "check") {
        await m.reply("Checking for updates...");
        const result = await checkUpdates(cfg);
        if (result.upToDate) {
          return await m.reply(`Bot is up to date.\n\nCurrent: ${result.curr}`);
        }

        const commits = result.commits
          .slice(0, 10)
          .map(
            (c, i) =>
              `${i + 1}. [${c.hash}] ${c.msg}${c.date ? ` (${c.date})` : ""}`,
          )
          .join("\n");
        const more =
          result.totalCommits > 10
            ? `\n... and ${result.totalCommits - 10} more commits`
            : "";

        return await m.reply(
          `Updates available.\n\n` +
            `Current: ${result.curr}\n` +
            `Latest: ${result.latest}\n` +
            `Total: ${result.totalCommits}\n\n` +
            `${commits}${more}\n\n` +
            `Use ${bot.prefix}update now to update.`,
        );
      }

      if (sub === "now") {
        await m.reply("Updating...");
        const result = await applyUpdate(cfg);

        if (result.upToDate) {
          return await m.reply(`Bot is up to date.\n\nCurrent: ${result.curr}`);
        }

        if (!result.ok) {
          return await m.reply(
            `Update failed.\n\n` +
              `Failed files: ${result.failed.length}\n` +
              `${shortList(result.failed)}`,
          );
        }

        const commits =
          result.commits
            .map((c, i) => `${i + 1}. [${c.hash}] ${c.msg}`)
            .join("\n") || "none";

        await m.reply(
          `Update completed.\n\n` +
            `From: ${result.curr}\n` +
            `To: ${result.latest}\n\n` +
            `Applied commits:\n${commits}\n\n` +
            `Updated: ${result.updated.length}\n` +
            `Removed: ${result.removed.length}\n` +
            `Skipped: ${result.skipped.length}`,
        );

        if (result.needRestart) {
          await m.reply("Restarting bot...");
          try {
            require("../../lib/restartNotice").mark("update", m.chat);
          } catch {}
          setTimeout(() => process.exit(0), 1000);
          return;
        }

        const _done = require("../../lib/restartNotice").MESSAGES.update;

        if (result.commandOnly && bot.reloader) {
          const reload = await bot.reloader.reload();
          await m.reply(reload.message);
          return await m.reply(_done);
        }

        return await m.reply(_done);
      }

      return await m.reply(
        `Usage:\n` +
          `${bot.prefix}update check\n` +
          `${bot.prefix}update now\n\n` +
          `Repo: ${cfg.owner}/${cfg.repo} @ ${cfg.branch}\n\n` +
          `If updates pull from the wrong repo:\n` +
          `${bot.prefix}setvar UPDATE_REPO=owner/repo\n` +
          `Example: ${bot.prefix}setvar UPDATE_REPO=CodexABQ/CODEX-AI`,
      );
    } catch (e) {
      return await m.reply(`Update error: ${e.message}`);
    }
  },
};
