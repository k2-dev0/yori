import { z } from 'zod';

// model_paramsのうち、思考量を表す項目のid。公式仕様の例では値が`max`などの文字列で入る。
const EFFORT_MODEL_PARAM_ID = 'effort';

const cursorCommonHookSchema = z.object({
  conversation_id: z.string().min(1),
  generation_id: z.string().min(1),
  model: z.string().min(1),
  model_id: z.string().min(1).optional(),
  model_params: z.array(z.object({ id: z.string(), value: z.string() })).optional(),
  cursor_version: z.string().min(1),
  workspace_roots: z.array(z.string().min(1)).min(1),
  user_email: z.string().nullable().optional(),
  transcript_path: z.string().nullable().optional(),
});

const cursorHookSchema = z.discriminatedUnion('hook_event_name', [
  cursorCommonHookSchema.extend({
    hook_event_name: z.literal('beforeSubmitPrompt'),
    prompt: z.string(),
    attachments: z.array(z.unknown()).optional(),
  }),
  cursorCommonHookSchema.extend({
    hook_event_name: z.literal('afterAgentResponse'),
    text: z.string(),
  }),
]);

export interface CursorCollectorHookInput {
  session_id: string;
  generation_id: string;
  hook_event_name: 'beforeSubmitPrompt' | 'afterAgentResponse';
  workspace_roots: string[];
  model_id: string;
  reasoning_effort?: string;
  client_version: string;
  prompt?: string;
  text?: string;
}

// Cursor公式hook入力をcollector内部の共通identityへ変換し、本文以外の追加fieldは保持しない。
export function parseCursorHookInput(value: unknown): CursorCollectorHookInput | null {
  const parsed = cursorHookSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const effort = parsed.data.model_params?.find((param) => param.id === EFFORT_MODEL_PARAM_ID)?.value;
  const common = {
    session_id: parsed.data.conversation_id,
    generation_id: parsed.data.generation_id,
    hook_event_name: parsed.data.hook_event_name,
    workspace_roots: parsed.data.workspace_roots,
    model_id: parsed.data.model_id ?? parsed.data.model,
    // 空文字は保存できる値ではないので、思考量なしとして扱う。
    ...(effort === undefined || effort === '' ? {} : { reasoning_effort: effort }),
    client_version: parsed.data.cursor_version,
  };
  return parsed.data.hook_event_name === 'beforeSubmitPrompt'
    ? { ...common, prompt: parsed.data.prompt }
    : { ...common, text: parsed.data.text };
}
