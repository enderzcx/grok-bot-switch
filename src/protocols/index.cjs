"use strict";

var contract = require("./contract.cjs");
var openaiChat = require("./openai-chat.cjs");
var openaiResponses = require("./openai-responses.cjs");
var anthropicMessages = require("./anthropic-messages.cjs");

var REGISTRY = Object.freeze({
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages
});

function getAdapter(protocolId) {
  if (typeof protocolId !== "string" || !Object.prototype.hasOwnProperty.call(REGISTRY, protocolId)) {
    throw contract.protocolError("Unknown provider protocol", { code: "unknown-protocol" });
  }
  return REGISTRY[protocolId];
}

function createAdapter(protocolId) {
  return getAdapter(protocolId);
}

module.exports = {
  PROTOCOL_IDS: contract.PROTOCOL_IDS,
  DEFAULT_ENDPOINT_PATHS: contract.DEFAULT_ENDPOINT_PATHS,
  DEFAULT_AUTH_TYPES: contract.DEFAULT_AUTH_TYPES,
  protocolError: contract.protocolError,
  getAdapter: getAdapter,
  createAdapter: createAdapter
};
