// Kali-Linux-flavoured terminal UI: ANSI colors, a dragon banner, and a small
// spinner animation. Honours NO_COLOR and non-TTY terminals.

const useColor = process.env.NO_COLOR ? false : process.stdout.isTTY !== false;

const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const color = {
  reset: "\x1b[0m",
  blue: c("38;5;39"),
  cyan: c("36"),
  red: c("38;5;196"),
  green: c("38;5;46"),
  yellow: c("33"),
  gray: c("90"),
  bold: c("1"),
  dim: c("2"),
  magenta: c("35"),
};

// Kali-style dragon + wordmark.
export function banner(version = "1.0.0") {
  const b = color.blue;
  const r = color.red;
  const g = color.gray;
  const art = [
    "",
    b("            ..............              "),
    b("        ..,;:ccccccccccc:;,..          "),
    b("     ..,clllcc;;;;;;;;;:::ccc;,..      "),
    b("   .,cllc;,'..            ..',;:c;.    "),
    b("  ;lol;.        ") + r("S U Z U") + b("        .;ol;   "),
    b(" ;ol,                              ,lo; "),
    b(",ol.    ") + r("APK RE  •  Telegram AI") + b("     .lo,"),
    b("'oc.                               .co'"),
    b(" :l;.                             .;l: "),
    b("  ;c:,..                       ..,:c;  "),
    b("   .;ccc:;,'...           ...',;:ccc;.  "),
    b("      .';:cccccc::::::::cccccc:;'.     "),
    b("           ..',;;;;;;;;;;,'..          "),
    "",
  ].join("\n");
  const title =
    color.bold(color.red("Suzu-JS")) +
    " " +
    color.gray(`v${version}`) +
    "  " +
    color.dim("— all-in-one APK reverse-engineering AI for Termux & servers");
  return art + "\n" + title + "\n";
}

export function line(ch = "─", n = 56) {
  return color.gray(ch.repeat(n));
}

export function ok(msg) {
  return color.green("✔ ") + msg;
}
export function warn(msg) {
  return color.yellow("⚠ ") + msg;
}
export function err(msg) {
  return color.red("✖ ") + msg;
}
export function info(msg) {
  return color.blue("➜ ") + msg;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Returns a controller with .update(text) and .stop(finalText).
export function spinner(initial = "Working…") {
  if (process.stdout.isTTY === false) {
    process.stdout.write(initial + "\n");
    return { update: () => {}, stop: (t) => t && process.stdout.write(t + "\n") };
  }
  let i = 0;
  let text = initial;
  const render = () => {
    process.stdout.write(`\r${color.cyan(FRAMES[i % FRAMES.length])} ${text}\x1b[K`);
    i++;
  };
  const timer = setInterval(render, 90);
  render();
  return {
    update: (t) => {
      text = t;
    },
    stop: (finalText) => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[K");
      if (finalText) process.stdout.write(finalText + "\n");
    },
  };
}
