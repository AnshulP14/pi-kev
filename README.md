# pi-kev

A [Pi](https://github.com/badlogic/pi-mono) package that turns [Kev](https://github.com/jaredpalmer/kev) into a local, asynchronous decision layer for search-result, repository, and document triage.

It adds two tools:

- `kev_decide` queues fixed-choice classification over inline text, files, or folders.
- `kev_decide_status` reports progress and returns result pages with confidence, probabilities, and the relevant input range.

Kev is a separate Apache-2.0 project by Jared Palmer. This repository contains only the Pi integration.

## Install

```bash
git clone https://github.com/jaredpalmer/kev.git ~/src/kev
cd ~/src/kev && uv sync --extra serve

export KEV_ROOT=~/src/kev
pi install git:github.com/AnshulP14/pi-kev
```

`uv` and Python 3.12 or 3.13 are required by Kev. The first run downloads the selected model.

For PDF, Office, and OpenDocument extraction, install [`anydoc`](https://www.npmjs.com/package/anydoc) so it is on `PATH`, or set `KEV_ANYDOC` to its executable path. Plain-text and code files do not need it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEV_ROOT` | required | Path to a local clone of `jaredpalmer/kev` |
| `KEV_MODEL` | `jaredpalmer/kev-0.8b@v1.0` | Model passed to `kev.serve` |
| `KEV_PORT` | `8011` | Local Kev server port |
| `KEV_RESULTS_DIR` | `~/.pi/agent/kev-results` | Persisted completed-job results |
| `KEV_ANYDOC` | `anydoc` | Document extractor executable |

## Example

```text
kev_decide(
  sources: ["./candidate-jobs"],
  questions: [{
    id: "fit",
    instruction: "Is this a 4–6 YOE Bengaluru Applied AI role?",
    choices: ["strong-fit", "stretch", "reject"]
  }]
)
```

Use it for fixed-choice decisions only—not open-ended summarization. Review low-confidence or consequential decisions against the cited evidence range.

## Development

```bash
npm test
```

## License

MIT. Kev itself is Apache-2.0; see its [upstream repository](https://github.com/jaredpalmer/kev).
