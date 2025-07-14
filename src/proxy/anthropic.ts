import { Request, RequestHandler, Router } from "express";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [], has_more: false, first_id: null, last_id: null };

  const claudeVariants = [
    ["claude-2", "Claude 2"],
    ["claude-2.0", "Claude 2.0"],
    ["claude-2.1", "Claude 2.1"],
    ["claude-3-haiku-20240307", "Claude 3 Haiku"],
    ["claude-3-5-haiku-20241022", "Claude 3.5 Haiku"],
    ["claude-3-opus-20240229", "Claude 3 Opus"],
    ["claude-3-opus-latest", "Claude 3 Opus (latest)"],
    ["claude-3-sonnet-20240229", "Claude 3 Sonnet"],
    ["claude-3-5-sonnet-20240620", "Claude 3.5 Sonnet (Old)"],
    ["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet (New)"],
    ["claude-3-5-sonnet-latest", "Claude 3.5 Sonnet (Latest)"],
    ["claude-3-7-sonnet-20250219", "Claude 3.7 Sonnet"],
    ["claude-3-7-sonnet-latest", "Claude 3.7 Sonnet (Latest)"],
    ["claude-sonnet-4-20250514", "Claude Sonnet 4"],
    ["claude-opus-4-20250514", "Claude Opus 4"]

  ];

  const date = new Date()
  const models = claudeVariants.map(([id, display_name]) => ({
    // Common
    id,
    owned_by: "anthropic",
    // Anthropic
    type: "model",
    display_name,
    created_at: date.toISOString(),
    // OpenAI
    object: "model",
    created: date.getTime(),
  }));  

  modelsCache = { 
    // Common
    object: "list",
    data: models,
    // Anthropic
    has_more: false,
    first_id: claudeVariants[0][0],
    last_id: claudeVariants.at(-1)![0],
  };
  modelsCacheTime = date.getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const anthropicBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-text":
      req.log.info("Transforming Anthropic Text back to OpenAI format");
      newBody = transformAnthropicTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to Anthropic chat format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function flattenChatResponse(
  content: { type: string; text: string }[]
): string {
  return content
    .map((part: { type: string; text: string }) =>
      part.type === "text" ? part.text : ""
    )
    .join("\n");
}

export function transformAnthropicChatResponseToAnthropicText(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    type: "completion",
    id: "ant-" + anthropicBody.id,
    completion: flattenChatResponse(anthropicBody.content),
    stop_reason: anthropicBody.stop_reason,
    stop: anthropicBody.stop_sequence,
    model: anthropicBody.model,
    usage: anthropicBody.usage,
  };
}

function transformAnthropicTextResponseToOpenAI(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

export function transformAnthropicChatResponseToOpenAI(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: anthropicBody.usage,
    choices: [
      {
        message: {
          role: "assistant",
          content: flattenChatResponse(anthropicBody.content),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

/**
 * If a client using the OpenAI compatibility endpoint requests an actual OpenAI
 * model, reassigns it to Sonnet.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;
  if (model.includes("claude")) return; // use whatever model the user requested
  req.body.model = "claude-3-5-sonnet-latest";
}

/**
 * If client requests more than 4096 output tokens the request must have a
 * particular version header.
 * https://docs.anthropic.com/en/release-notes/api#july-15th-2024
 */
function setAnthropicBetaHeader(req: Request) {
  const { max_tokens_to_sample } = req.body;
  if (max_tokens_to_sample > 4096) {
    req.headers["anthropic-beta"] = "max-tokens-3-5-sonnet-2024-07-15";
  }
}

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  req.log.debug({ pathname }, "Anthropic path filter");
  const isText = req.outboundApi === "anthropic-text";
  const isChat = req.outboundApi === "anthropic-chat";
  if (isChat && pathname === "/v1/complete") {
    manager.setPath("/v1/messages");
  }
  if (isText && pathname === "/v1/chat/completions") {
    manager.setPath("/v1/complete");
  }
  if (isChat && pathname === "/v1/chat/completions") {
    manager.setPath("/v1/messages");
  }
  if (isChat && ["sonnet", "opus"].includes(req.params.type)) {
    manager.setPath("/v1/messages");
  }
}

const anthropicProxy = createQueuedProxyMiddleware({
  target: "https://api.anthropic.com",
  mutations: [selectUpstreamPath, addKey, finalizeBody],
  blockingResponseHandler: anthropicBlockingResponseHandler,
});

const nativeAnthropicChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "anthropic" },
  { afterTransform: [setAnthropicBetaHeader] }
);

const nativeTextPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-text",
  service: "anthropic",
});

const textToChatPreprocessor = createPreprocessorMiddleware({
  inApi: "anthropic-text",
  outApi: "anthropic-chat",
  service: "anthropic",
});

/**
 * Routes text completion prompts to anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAnthropicTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.startsWith("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToTextPreprocessor = createPreprocessorMiddleware({
  inApi: "openai",
  outApi: "anthropic-text",
  service: "anthropic",
});

const oaiToChatPreprocessor = createPreprocessorMiddleware({
  inApi: "openai",
  outApi: "anthropic-chat",
  service: "anthropic",
});

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  maybeReassignModel(req);
  if (req.body.model?.includes("claude-3")) {
    oaiToChatPreprocessor(req, res, next);
  } else {
    oaiToTextPreprocessor(req, res, next);
  }
};

const anthropicRouter = Router();
anthropicRouter.get("/v1/models", handleModelRequest);
// Native Anthropic chat completion endpoint.
anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  nativeAnthropicChatPreprocessor,
  anthropicProxy
);
// Anthropic text completion endpoint. Translates to Anthropic chat completion
// if the requested model is a Claude 3 model.
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAnthropicTextRequest,
  anthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint. Accepts an OpenAI chat completion
// request and transforms/routes it to the appropriate Anthropic format and
// endpoint based on the requested model.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  anthropicProxy
);

export const anthropic = anthropicRouter;
