# Reroute

Type a London from/to pair (or tap your saved home/work). Reroute plans the trip, checks
live TfL line status against it, and gives a plain-English verdict. It also shows the exact
route to take, live crowding at each station, and a TfL-style departure board for where you
board.

Built with Bun, Hono, htmx and Pico.css. The verdict comes from a Claude Agent SDK agent on
Amazon Bedrock that uses four TfL tools. See [PLAN.md](PLAN.md) for the architecture.

## Run it locally

Prerequisites: [Bun](https://bun.sh) (installed at `~/.bun/bin`), the AWS CLI, and a TfL
API key.

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install

cp .env.example .env          # then fill in TFL_APP_KEY and VERDICT_MODEL_ID
aws sso login --profile genai # SSO credentials expire, so log in right before a demo

bun run start                 # http://localhost:3000
```

`.env` is gitignored and must never be committed. Secrets are read only from the
environment.

All scripts run `bun --use-system-ca`. Without it, Bun rejects the Zscaler-signed TLS
certificates on this network and every TfL call fails.

## Demo script

1. **Autocomplete:** start typing "bank". Suggestions appear instantly, with line pills and
   live crowding for the highlighted station.
2. **Saved stations:** pick a station and click "Set as home", then pick another and click
   "Set as work". One-tap "Check now" buttons appear, and the morning or evening direction is
   listed first depending on the time of day.
3. **Check a route:** the gauge's train moves as the agent actually works (finding
   stations, planning, checking lines, reading notices, writing the verdict).
4. **Result:** the verdict, the exact route as a line-coloured strip map with live times and
   crowding, and a live amber departure board for your first leg. The board refreshes every
   20s, marks your platform, and scrolls line status along the bottom.
5. **Disrupted line:** pick a pair on whichever line is currently disrupted
   (`curl "https://api.tfl.gov.uk/Line/Mode/tube,overground,elizabeth-line,dlr/Status?app_key=…"`).

## Other commands

| Command | What it does |
|---|---|
| `bun run dev` | Server with hot reload |
| `bun run probe:tfl` | Hits the four TfL tools directly (no AI) and shows cache hits |
| `bun run probe:agent "From" "To"` | Runs one verdict from the CLI and prints the token cost |
| `curl localhost:3000/healthz` | Checks config: which values are present, without showing them |
