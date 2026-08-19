import { useEffect } from 'react'
import { maybeSendConsolePing } from '@/utils/consolePing'

// 30 分钟：兜住「一直开着不关」的会话，跨午夜后自动补打
const PING_INTERVAL_MS = 30 * 60 * 1000

/**
 * 让 console ping 每个 UTC 日至多一次：挂载时、窗口重新可见时、以及定时器周期各检查一次。
 * 取代旧的「启动只打一次」，使长时间运行的会话仍能每天登记。
 */
export function usePingCadence(): void {
  useEffect(() => {
    maybeSendConsolePing()

    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeSendConsolePing()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(() => maybeSendConsolePing(), PING_INTERVAL_MS)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])
}
