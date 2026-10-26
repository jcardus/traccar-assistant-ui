# Traccar assistant UI

Shared ChatKit component for the independent dashboard and assistant frontends.
This private package is installed from Git; it is never published to npm.

```tsx
import { AssistantPanel } from '@traccar/assistant-ui';

<AssistantPanel
  apiUrl="/chatkit"
  domainKey="your-domain-key"
  theme="light"
  onShowHtml={({ params }) => setHtml(params.html)}
  onClearPanel={() => setHtml(null)}
/>
```

The host supplies a container with an explicit height, loads the ChatKit script
(`https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`), and renders the
HTML or map content. Optional `onShowMap` handles `show_map`. Optional `chatTheme`
overrides the widget theme. Layout and Tailwind styles stay in each host app.

Includes attachment uploads, screenshot tool responses, HTML restoration when
switching threads, and generated HTML error forwarding. The share icon at the
top right of the header prints the open conversation. Attachment limits must
stay aligned with backend/app/attachments.py in traccar-chatkit.

## Install and update

Install using the full Git commit hash, and commit package.json/package-lock.json
in each consumer. Update both consumers deliberately when releasing shared changes:

```sh
npm install git+https://github.com/jcardus/traccar-assistant-ui.git#COMMIT_SHA
```

Develop with `npm ci` and `npm run build`. Git installs run `prepare` to build JS
and declarations. React and React DOM are peer dependencies (18.3 or 19), so each
host provides its own React. Do not copy the component back into either host.

Private Git access is required on developer machines and CI/build servers. Give
both deployment pipelines read access to this repository before deploying the
consumer changes. Keep credentials in the pipeline's secret store; never put
tokens in package.json or a lockfile. Local builds do not verify remote CI access.
