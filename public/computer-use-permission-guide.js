(function () {
  'use strict';

  const bridge = window.__ABU_PERMISSION_GUIDE__;
  if (!bridge) return;

  const elements = {
    appIcon: document.getElementById('appIcon'),
    title: document.getElementById('title'),
    description: document.getElementById('description'),
    screenRow: document.getElementById('screenRow'),
    screenTitle: document.getElementById('screenTitle'),
    screenDescription: document.getElementById('screenDescription'),
    screenStep: document.getElementById('screenStep'),
    screenAction: document.getElementById('screenAction'),
    controlRow: document.getElementById('controlRow'),
    controlTitle: document.getElementById('controlTitle'),
    controlDescription: document.getElementById('controlDescription'),
    controlStep: document.getElementById('controlStep'),
    controlAction: document.getElementById('controlAction'),
    errorBanner: document.getElementById('errorBanner'),
    errorTitle: document.getElementById('errorTitle'),
    errorMessage: document.getElementById('errorMessage'),
    retryButton: document.getElementById('retryButton'),
    developmentNote: document.getElementById('developmentNote'),
    missingApp: document.getElementById('missingApp'),
    revealButton: document.getElementById('revealButton'),
    cancelButton: document.getElementById('cancelButton'),
    returnButton: document.getElementById('returnButton'),
    privacyNote: document.getElementById('privacyNote'),
    closeButton: document.getElementById('closeButton'),
  };

  function setText(element, value) {
    if (element) element.textContent = typeof value === 'string' ? value : '';
  }

  function renderPermission(row, action, {
    granted,
    current,
    requesting,
    strings,
  }) {
    row.classList.toggle('is-complete', granted);
    row.classList.toggle('is-current', current && !granted);
    row.classList.toggle('is-upcoming', !current && !granted);
    row.classList.toggle('is-requesting', requesting);
    action.disabled = granted || !current || requesting;
    action.textContent = granted
      ? strings.done
      : requesting
        ? strings.checking
        : strings.allow;
  }

  function render(state) {
    if (!state || !state.strings || !state.view) return;
    const strings = state.strings;
    const view = state.view;

    if (state.iconDataUrl) elements.appIcon.src = state.iconDataUrl;
    setText(elements.title, strings.title);
    setText(elements.description, strings.description);
    setText(elements.screenTitle, strings.screenTitle);
    setText(elements.screenDescription, strings.screenDescription);
    setText(elements.screenStep, strings.screenStep);
    setText(elements.controlTitle, strings.controlTitle);
    setText(elements.controlDescription, strings.controlDescription);
    setText(elements.controlStep, strings.controlStep);
    setText(elements.errorTitle, strings.errorTitle);
    setText(elements.retryButton, strings.retry);
    setText(elements.revealButton, strings.revealApp);
    setText(elements.cancelButton, strings.cancel);
    setText(elements.returnButton, strings.returnToAbu);
    setText(elements.privacyNote, strings.privacyNote);
    elements.closeButton.setAttribute('aria-label', strings.cancel);

    renderPermission(elements.screenRow, elements.screenAction, {
      granted: view.permissions.screenRead,
      current: view.currentPermission === 'screenRead',
      requesting: view.requesting === 'screenRead',
      strings,
    });
    renderPermission(elements.controlRow, elements.controlAction, {
      granted: view.permissions.uiControl,
      current: view.currentPermission === 'uiControl',
      requesting: view.requesting === 'uiControl',
      strings,
    });

    elements.errorBanner.hidden = !view.error;
    setText(elements.errorMessage, view.error);
    elements.developmentNote.hidden = !state.development;
    setText(elements.developmentNote, strings.developmentIdentity);
    setText(elements.missingApp, strings.missingApp);
    elements.returnButton.hidden = !view.complete;
    elements.cancelButton.hidden = view.complete;
  }

  elements.screenAction.addEventListener('click', () => {
    bridge.sendAction({ type: 'request', permission: 'screenRead' });
  });
  elements.controlAction.addEventListener('click', () => {
    bridge.sendAction({ type: 'request', permission: 'uiControl' });
  });
  elements.retryButton.addEventListener('click', () => {
    bridge.sendAction({ type: 'retry' });
  });
  elements.revealButton.addEventListener('click', () => {
    bridge.sendAction({ type: 'reveal' });
  });
  elements.cancelButton.addEventListener('click', () => {
    bridge.sendAction({ type: 'cancel' });
  });
  elements.closeButton.addEventListener('click', () => {
    bridge.sendAction({ type: 'cancel' });
  });
  elements.returnButton.addEventListener('click', () => {
    bridge.sendAction({ type: 'return' });
  });

  bridge.onState(render);
  bridge.getState().then(render).catch(() => {});
}());
