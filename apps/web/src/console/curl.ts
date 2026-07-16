import { modelConfigFor } from '../lib/models'

// The Quick Start's right-hand code panel. Unlike the prototype's illustrative sample, this
// mirrors the *real* requests the console makes (and the README quickstart), so a developer
// can copy it straight into a terminal. It grows a block per completed step.
export type CurlState = {
  step: number
  agentName: string
  model: string
  systemPrompt: string
  envName: string
  envDesc: string
  message: string
}

const j = (s: string) => JSON.stringify(s)

export function buildCurl(st: CurlState): string {
  const { provider, model } = modelConfigFor(st.model)
  let code = [
    'export TOKEN=$FUNKY_AUTH_TOKEN            # the token from your .env',
    'export H="Authorization: Bearer $TOKEN"',
    'export J="content-type: application/json"',
  ].join('\n')

  if (st.step >= 1) {
    code += `\n\n# 1. an agent: who it is and what model it uses
AID=$(curl -s -X POST localhost:3000/v1/agents -H "$H" -H "$J" -d '{
  "name": ${j(st.agentName || 'my agent')},
  "system_prompt": ${j(st.systemPrompt || 'You are a helpful engineer.')},
  "model": { "provider": ${j(provider)}, "model": ${j(model)} }
}' | jq -r .id)`
  }

  if (st.step >= 2) {
    code += `\n\n# 2. an environment: where its commands run
EID=$(curl -s -X POST localhost:3000/v1/environments -H "$H" -H "$J" -d '{
  "name": ${j(st.envName || 'basic')},
  "description": ${j(st.envDesc || 'default dev box')}
}' | jq -r .id)`
  }

  if (st.step >= 3) {
    code += `\n\n# 3. a session: an agent + an environment, with a durable event log
SID=$(curl -s -X POST localhost:3000/v1/sessions -H "$H" -H "$J" \\
  -d "{\\"agent\\":\\"$AID\\",\\"environment_id\\":\\"$EID\\"}" | jq -r .id)`
  }

  if (st.step >= 4) {
    code += `\n\n# 4. send the first message (watch it think on the events stream)
curl -N -H "$H" localhost:3000/v1/sessions/$SID/events/stream &
curl -s -X POST localhost:3000/v1/sessions/$SID/messages -H "$H" -H "$J" \\
  -d '{"content": ${j(st.message || 'say hello from the sandbox')}}'`
  }

  return code
}
