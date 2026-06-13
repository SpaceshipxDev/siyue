import 'server-only'
import { Text, View } from '@react-pdf/renderer'
import { BRAND } from './../brand'
import { COLOR } from './styles'

// Shared footer for every printed doc (出货单 / 外协单 / 出厂检验报告). The only
// branding a customer or vendor sees, so it carries the domain as a curiosity
// hook: 思跃 (lighter ink) · siyue.ai (darker ink — the eye lands here). The
// domain keeps minimal letter-spacing so it reads as a typeable URL, not a
// decorated label. Fixed to the page bottom inside the 40pt margin: it repeats
// on every page and never collides with content.
export function DocFooter() {
  return (
    <View
      fixed
      style={{
        position: 'absolute',
        bottom: 18,
        left: 40,
        right: 40,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'baseline',
      }}
    >
      <Text style={{ fontSize: 7.5, color: COLOR.ink3, letterSpacing: 1.4 }}>
        {BRAND.software}
      </Text>
      <Text style={{ fontSize: 7.5, color: COLOR.ink4, marginHorizontal: 5 }}>
        ·
      </Text>
      <Text style={{ fontSize: 8.5, color: COLOR.ink2, letterSpacing: 0.3 }}>
        {BRAND.domain}
      </Text>
    </View>
  )
}
