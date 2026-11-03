'use strict';

const contexts = new WeakMap();

function isRendererCallbackContextId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function registerRendererCallbackContext(sender, contextId) {
  if (!isRendererCallbackContextId(contextId)) {
    throw new Error('Invalid renderer callback context identity');
  }
  const previous = contexts.get(sender);
  contexts.set(sender, contextId);
  return previous;
}

function forgetRendererCallbackContext(sender) {
  const previous = contexts.get(sender);
  contexts.delete(sender);
  return previous;
}

function isCurrentRendererCallbackOwner(owner) {
  return !!owner?.sender
    && !owner.sender.isDestroyed()
    && isRendererCallbackContextId(owner.contextId)
    && contexts.get(owner.sender) === owner.contextId;
}

function assertCurrentRendererCallbackOwner(owner) {
  if (!isCurrentRendererCallbackOwner(owner)) {
    throw new Error('Renderer callback context is no longer active');
  }
}

function captureRendererCallbackOwner(sender, contextId) {
  const owner = Object.freeze({ sender, contextId });
  assertCurrentRendererCallbackOwner(owner);
  return owner;
}

module.exports = {
  isRendererCallbackContextId,
  registerRendererCallbackContext,
  forgetRendererCallbackContext,
  captureRendererCallbackOwner,
  isCurrentRendererCallbackOwner,
  assertCurrentRendererCallbackOwner,
};
