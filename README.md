# Xray + Playwright + LLM agent

This follow-up version adds:

- fetch tests live from **Xray Cloud** by **issue key** or **JQL**
- map Xray tests directly into the Playwright runner
- save local results first, then ask you to **approve or reject** upload
- pause automation, perform the step manually, and continue
- save run state so you can **resume later**
- record manual browsing events and ask the LLM to generate **AI-friendly Jira/Xray manual steps**

## Install

```bash
npm install
npx playwright install
cp .env.example .env
```

## Run from sample JSON

```bash
npm run dev -- --file examples/manual-test-google-contacts.json
```

## Run from Xray issue key

```bash
npm run dev -- --xray-issue DOCS-101
```

## Run from Xray JQL

```bash
npm run dev -- --xray-jql "project = DOCS AND issuetype = Test"
```

## Resume a paused run

```bash
npm run dev -- --resume out/run-states/<run-id>.json
```

## Approve or reject upload after manual verification

```bash
npm run approve:upload -- out/pending-uploads/<file>.json --approve
npm run approve:upload -- out/pending-uploads/<file>.json --reject
```

## Generate Jira/Xray-friendly manual steps from recorded browsing

1. Record a session:
   - start the browser
   - browse manually
   - raw events go to `out/recordings/*.json`
2. Generate rewritten steps:

```bash
npm run generate:steps -- out/recordings/<file>.json
```

## Notes

- Xray Cloud auth uses Client ID / Client Secret and bearer tokens.
- Result uploads are intentionally gated by manual approval.
- Check the example raw payloads under `examples/xray-samples/` and adjust mappings if your tenant differs.
