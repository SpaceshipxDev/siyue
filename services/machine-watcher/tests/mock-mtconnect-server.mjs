import http from 'node:http'

const port = Number(process.env.MTCONNECT_TEST_PORT || 5000)
const probe = `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.0">
  <Devices><Device id="dev" name="Test Mill"><Description manufacturer="YINGMA" model="OPEN-CNC">Test controller</Description></Device></Devices>
</MTConnectDevices>`
const current = `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectStreams xmlns="urn:mtconnect.org:MTConnectStreams:2.0">
  <Streams><DeviceStream name="Test Mill"><ComponentStream component="Controller">
    <Events>
      <Execution dataItemId="execution">ACTIVE</Execution>
      <Program dataItemId="program">O1234.NC</Program>
      <PartCount dataItemId="parts">42</PartCount>
      <PartCountTarget dataItemId="target">100</PartCountTarget>
    </Events>
    <Samples>
      <CycleTime dataItemId="cycle">PT1M2.5S</CycleTime>
      <CuttingTime dataItemId="cutting">51.25</CuttingTime>
      <SpindleSpeed dataItemId="spindle">8000</SpindleSpeed>
      <PathFeedrate dataItemId="feed">1200</PathFeedrate>
    </Samples>
  </ComponentStream></DeviceStream></Streams>
</MTConnectStreams>`

const server = http.createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end()
    return
  }
  if (request.url === '/probe') {
    response.writeHead(200, { 'content-type': 'application/xml' }).end(probe)
    return
  }
  if (request.url === '/current') {
    response.writeHead(200, { 'content-type': 'application/xml' }).end(current)
    return
  }
  response.writeHead(404).end()
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`READY ${port}\n`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
