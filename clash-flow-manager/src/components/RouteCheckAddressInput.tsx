import { DropdownSelect } from './DropdownSelect'
import type { UrlProtocol } from '../core/routeCheckUrl'

export function RouteCheckAddressInput(props: {
  id: string
  protocol: UrlProtocol
  onProtocolChange: (protocol: UrlProtocol) => void
  address: string
  onAddressChange: (address: string) => void
  disabled?: boolean
}) {
  return <div className="route-check-url-entry">
    <DropdownSelect
      value={props.protocol}
      onValueChange={(value) => props.onProtocolChange(value as UrlProtocol)}
      aria-label="选择链接协议"
      disabled={props.disabled}
      className="route-check-protocol"
    >
      <option value="https">https://</option>
      <option value="http">http://</option>
    </DropdownSelect>
    <input
      id={props.id}
      type="text"
      inputMode="url"
      value={props.address}
      onChange={(event) => props.onAddressChange(event.target.value)}
      placeholder="www.example.com/"
      autoComplete="url"
      spellCheck={false}
      disabled={props.disabled}
      required
    />
  </div>
}
