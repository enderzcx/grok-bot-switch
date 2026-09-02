"use strict";

var contract = require("./contract.cjs");

function asUtf8Bytes(chunk, protocolId) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof ArrayBuffer !== "undefined" && chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  throw contract.protocolError("SSE decoder requires UTF-8 bytes", {
    protocol: protocolId,
    code: "invalid-request"
  });
}

function splitSseLines(text, isEnd) {
  var lines = [];
  var start = 0;
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code === 10) {
      lines.push(text.slice(start, i));
      start = i + 1;
    } else if (code === 13) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        lines.push(text.slice(start, i));
        i += 1;
        start = i + 1;
      } else if (i + 1 < text.length || isEnd) {
        lines.push(text.slice(start, i));
        start = i + 1;
      }
    }
  }
  var rest = text.slice(start);
  if (isEnd && rest.length > 0) {
    lines.push(rest);
    rest = "";
  }
  return { lines: lines, rest: rest };
}

function createSseDecoder(options) {
  options = options || {};
  var protocolId = options.protocol;
  var utf8 = new TextDecoder("utf-8", { fatal: true });
  var textBuffer = "";
  var pendingData = [];
  var pendingEvent = "";
  var pendingId = "";
  var ended = false;
  var strippedBom = false;

  function dispatch() {
    if (pendingData.length === 0) {
      pendingEvent = "";
      pendingId = "";
      return null;
    }
    var data = pendingData.join("\n");
    var eventName = pendingEvent;
    var id = pendingId;
    pendingData = [];
    pendingEvent = "";
    pendingId = "";
    if (data.trim().length === 0) {
      return null;
    }
    return {
      event: eventName.length > 0 ? eventName : "message",
      data: data,
      id: id
    };
  }

  function handleLine(line) {
    if (line.length === 0) {
      return dispatch();
    }
    if (line.charCodeAt(0) === 58) {
      return null;
    }
    var colon = line.indexOf(":");
    var field;
    var value;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) {
        value = value.slice(1);
      }
    }
    if (field === "data") {
      pendingData.push(value);
    } else if (field === "event") {
      pendingEvent = value;
    } else if (field === "id") {
      pendingId = value;
    }
    return null;
  }

  function consume(isEnd) {
    var events = [];
    var lines = splitSseLines(textBuffer, isEnd);
    textBuffer = lines.rest;
    for (var i = 0; i < lines.lines.length; i += 1) {
      var event = handleLine(lines.lines[i]);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  return {
    push: function (chunk) {
      if (ended) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: protocolId,
          code: "invalid-request"
        });
      }
      var bytes = asUtf8Bytes(chunk, protocolId);
      var decoded;
      try {
        decoded = utf8.decode(bytes, { stream: true });
      } catch (_error) {
        throw contract.protocolError("SSE stream is truncated", {
          protocol: protocolId,
          code: "truncated"
        });
      }
      if (!strippedBom && decoded.length > 0) {
        if (decoded.charCodeAt(0) === 0xfeff) {
          decoded = decoded.slice(1);
        }
        strippedBom = true;
      }
      textBuffer += decoded;
      return consume(false);
    },
    close: function () {
      if (ended) {
        throw contract.protocolError("SSE decoder is already finished", {
          protocol: protocolId,
          code: "invalid-request"
        });
      }
      ended = true;
      try {
        textBuffer += utf8.decode();
      } catch (_error) {
        throw contract.protocolError("SSE stream is truncated", {
          protocol: protocolId,
          code: "truncated"
        });
      }
      var events = consume(true);
      if (pendingData.length > 0) {
        var last = dispatch();
        if (last) {
          events.push(last);
        }
      }
      return events;
    }
  };
}

module.exports = {
  createSseDecoder: createSseDecoder,
  asUtf8Bytes: asUtf8Bytes
};
