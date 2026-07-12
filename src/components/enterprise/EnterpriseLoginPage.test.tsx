/// <reference types="@testing-library/jest-dom" />
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EnterpriseLoginPage from './EnterpriseLoginPage'
import type { BootstrapDTO } from '@/core/enterprise/bootstrap'
import type { EnterpriseBinding } from '@/core/enterprise/types'

// ── Hoisted mocks (available inside vi.mock factories) ───────────────────────

const mockBind = vi.hoisted(() =>
  vi.fn<(binding: EnterpriseBinding) => Promise<void>>().mockResolvedValue(undefined),
)

// Mock startBind to avoid calling Tauri openUrl
vi.mock('@/core/enterprise/auth', () => ({
  startBind: vi.fn(),
}))

// Mock enterpriseStore so we can capture what bind() is called with.
// useEnterpriseStore is called as a selector-hook in the component.
vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: (selector: (s: { bind: typeof mockBind }) => unknown) =>
    selector({ bind: mockBind }),
  getBinding: vi.fn(),
  isEnterprise: vi.fn(),
}))

global.fetch = vi.fn()

function makeBootstrap(
  methods: string[],
  ssoButtonLabel = 'Sign in with SSO',
): BootstrapDTO {
  return {
    instanceName: 'Test Corp',
    branding: { name: 'Test Corp', logoUrl: null, primaryColor: null },
    auth: {
      methods,
      ...(methods.includes('sso') ? { sso: { provider: 'generic', buttonLabel: ssoButtonLabel } } : {}),
    },
    registration: { mode: 'open_approval', domainAllowlist: [] },
    minClientVersion: '0.6.0',
    configVersion: 'sha256-test',
  }
}

describe('EnterpriseLoginPage', () => {
  const serverUrl = 'https://test.acme.com'
  const onSuccess = vi.fn()

  beforeEach(() => {
    onSuccess.mockReset()
    vi.mocked(global.fetch).mockReset()
    mockBind.mockReset()
    mockBind.mockResolvedValue(undefined)
  })

  afterEach(() => cleanup())

  describe('only password method', () => {
    it('renders password form and no other method sections', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.getByTestId('password-form')).toBeInTheDocument()
      expect(screen.queryByTestId('sso-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('magic-form')).not.toBeInTheDocument()
    })

    it('does not render method tabs when single method', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    })
  })

  describe('only SSO method', () => {
    it('renders SSO button with the bootstrap-provided label', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['sso'], 'Sign in with Feishu')}
          onSuccess={onSuccess}
        />,
      )
      const btn = screen.getByTestId('sso-button')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('Sign in with Feishu')
    })

    it('does not render password form or magic link form', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['sso'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.queryByTestId('password-form')).not.toBeInTheDocument()
      expect(screen.queryByTestId('magic-form')).not.toBeInTheDocument()
    })
  })

  describe('all methods enabled', () => {
    it('renders a tab for each method', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password', 'magic_link', 'sso'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.getByTestId('method-tab-password')).toBeInTheDocument()
      expect(screen.getByTestId('method-tab-magic_link')).toBeInTheDocument()
      expect(screen.getByTestId('method-tab-sso')).toBeInTheDocument()
    })

    it('shows a tablist role', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password', 'magic_link', 'sso'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.getByRole('tablist')).toBeInTheDocument()
    })

    it('defaults to password tab and shows password form', () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password', 'magic_link', 'sso'])}
          onSuccess={onSuccess}
        />,
      )
      expect(screen.getByTestId('password-form')).toBeInTheDocument()
      // SSO button not visible until SSO tab is clicked
      expect(screen.queryByTestId('sso-button')).not.toBeInTheDocument()
    })
  })

  // ── Fix P1-1: SSO binding captures refreshToken + accessExpiresAt ─────────

  describe('SSO flow — refreshToken captured in binding', () => {
    it('passes refreshToken and accessExpiresAt from BindResult into bind()', async () => {
      const { startBind } = await import('@/core/enterprise/auth')
      const ssoAccessExpiresAt = '2026-06-26T10:15:00Z'
      const ssoRefreshToken = 'sso-refresh-token-abc'

      vi.mocked(startBind).mockResolvedValue({
        initResp: {
          device_code: 'dc-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://test.acme.com/device',
          verification_uri_complete: 'https://test.acme.com/device?code=ABCD-1234',
          expires_in: 300,
          interval: 2,
        },
        abort: vi.fn(),
        result: Promise.resolve({
          serverUrl: serverUrl,
          accessToken: 'sso-access-token',
          accessExpiresAt: ssoAccessExpiresAt,
          refreshToken: ssoRefreshToken,
          scopes: ['read', 'write'],
          llmEndpoint: null,
          llmVirtualKey: null,
        }),
      })

      // Mock GET /session after SSO completes
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          user: { id: 'u1', email: 'alice@acme.com', name: 'Alice' },
          org: { id: 'org1', name: 'Acme Corp' },
        }),
      } as Response)

      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['sso'])}
          onSuccess={onSuccess}
        />,
      )

      fireEvent.click(screen.getByTestId('sso-button'))

      await waitFor(() => {
        expect(mockBind).toHaveBeenCalledOnce()
      })

      const capturedBinding = mockBind.mock.calls[0][0]
      expect(capturedBinding.refreshToken).toBe(ssoRefreshToken)
      expect(capturedBinding.accessExpiresAt).toBe(ssoAccessExpiresAt)
      expect(capturedBinding.accessToken).toBe('sso-access-token')
    })

    it('does not fail when BindResult has no refreshToken (server without O4 support)', async () => {
      const { startBind } = await import('@/core/enterprise/auth')

      vi.mocked(startBind).mockResolvedValue({
        initResp: {
          device_code: 'dc-2',
          user_code: 'EFGH-5678',
          verification_uri: 'https://test.acme.com/device',
          verification_uri_complete: 'https://test.acme.com/device?code=EFGH-5678',
          expires_in: 300,
          interval: 2,
        },
        abort: vi.fn(),
        result: Promise.resolve({
          serverUrl: serverUrl,
          accessToken: 'old-access-token',
          // no refreshToken / accessExpiresAt
          scopes: ['read', 'write'],
          llmEndpoint: null,
          llmVirtualKey: null,
        }),
      })

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          user: { id: 'u1', email: 'bob@acme.com', name: 'Bob' },
          org: { id: 'org1', name: 'Acme Corp' },
        }),
      } as Response)

      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['sso'])}
          onSuccess={onSuccess}
        />,
      )

      fireEvent.click(screen.getByTestId('sso-button'))

      await waitFor(() => {
        expect(mockBind).toHaveBeenCalledOnce()
      })

      const capturedBinding = mockBind.mock.calls[0][0]
      expect(capturedBinding.refreshToken).toBeUndefined()
      expect(capturedBinding.accessExpiresAt).toBeUndefined()
    })
  })

  // ── Fix P2-6: login error code mapping ───────────────────────────────────

  describe('error code mapping — password form', () => {
    /** Helper: render password form, fill fields, submit, return the fetch mock. */
    async function submitPasswordForm(fetchResponse: Partial<Response>) {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['password'])}
          onSuccess={onSuccess}
        />,
      )

      fireEvent.change(screen.getByTestId('email-input'), { target: { value: 'a@b.com' } })
      fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'secret' } })

      vi.mocked(global.fetch).mockResolvedValueOnce(fetchResponse as Response)

      fireEvent.submit(screen.getByTestId('password-form'))
    }

    it('shows slow_down message with seconds when Retry-After header is present', async () => {
      await submitPasswordForm({
        ok: false,
        status: 429,
        headers: { get: (h: string) => (h === 'Retry-After' ? '30' : null) } as unknown as Headers,
        json: () => Promise.resolve({ error: 'slow_down' }),
      })

      await waitFor(() => {
        expect(screen.getByText(/30/)).toBeInTheDocument()
      })
    })

    it('shows generic slow_down message when no Retry-After header', async () => {
      await submitPasswordForm({
        ok: false,
        status: 429,
        headers: { get: () => null } as unknown as Headers,
        json: () => Promise.resolve({ error: 'slow_down' }),
      })

      await waitFor(() => {
        expect(screen.getByText(/Too many requests/i)).toBeInTheDocument()
      })
    })

    it('shows method_not_enabled error', async () => {
      await submitPasswordForm({
        ok: false,
        status: 403,
        headers: { get: () => null } as unknown as Headers,
        json: () => Promise.resolve({ error: 'method_not_enabled' }),
      })

      await waitFor(() => {
        expect(screen.getByText(/not enabled/i)).toBeInTheDocument()
      })
    })

    it('shows domain_not_allowed error', async () => {
      await submitPasswordForm({
        ok: false,
        status: 403,
        headers: { get: () => null } as unknown as Headers,
        json: () => Promise.resolve({ error: 'domain_not_allowed' }),
      })

      await waitFor(() => {
        expect(screen.getByText(/domain/i)).toBeInTheDocument()
      })
    })

    it('shows registration_closed error', async () => {
      await submitPasswordForm({
        ok: false,
        status: 403,
        headers: { get: () => null } as unknown as Headers,
        json: () => Promise.resolve({ error: 'registration_closed' }),
      })

      await waitFor(() => {
        expect(screen.getByText(/closed/i)).toBeInTheDocument()
      })
    })
  })

  describe('error code mapping — magic verify (expired_token)', () => {
    it('shows expired_token message when magic code has expired', async () => {
      render(
        <EnterpriseLoginPage
          serverUrl={serverUrl}
          bootstrap={makeBootstrap(['magic_link'])}
          onSuccess={onSuccess}
        />,
      )

      // First step: send code (succeeds)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response)

      const emailInput = screen.getAllByPlaceholderText(/you@company/i)[0]
      fireEvent.change(emailInput, { target: { value: 'a@b.com' } })
      fireEvent.submit(screen.getByRole('button', { name: /send code/i }))

      // Wait for verify step
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /verify/i })).toBeInTheDocument()
      })

      // Second step: verify code (returns expired_token)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => null } as unknown as Headers,
        json: () => Promise.resolve({ error: 'expired_token' }),
      } as Response)

      const codeInput = screen.getByPlaceholderText(/6-digit/i)
      fireEvent.change(codeInput, { target: { value: '123456' } })
      fireEvent.submit(screen.getByRole('button', { name: /verify/i }))

      await waitFor(() => {
        expect(screen.getByText(/expired/i)).toBeInTheDocument()
      })
    })
  })
})
