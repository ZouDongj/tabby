import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const OSCSuffixes = [Buffer.from('\x07'), Buffer.from('\x1b\\')]

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private copyRequested = new Subject<string>()

    private internalBuffer: Buffer = Buffer.alloc(0)

    feedFromSession (data: Buffer): void {
        this.internalBuffer = Buffer.concat([this.internalBuffer, data])

        let continueProcessing = true
        // 这个 while 循环负责处理所有 *完整* 的 OSC 序列
        while (continueProcessing) {
            continueProcessing = false

            const prefixIndex = this.internalBuffer.indexOf(OSCPrefix)

            if (prefixIndex === -1) {
                // 注意：这里不再直接传递数据，因为可能有没有前缀的常规数据，
                // 统一交由循环结束后的逻辑处理。
                break
            }
            
            const searchArea = this.internalBuffer.subarray(prefixIndex + OSCPrefix.length)
            const suffixMatches = OSCSuffixes
                .map((suffix): [Buffer, number] => [suffix, searchArea.indexOf(suffix)])
                .filter(([_, index]) => index !== -1)
                .sort(([_, a], [__, b]) => a - b)

            if (suffixMatches.length === 0) {
                // 找到了不完整的序列，退出循环，交由下面的收尾逻辑处理
                break
            }

            // --- 以下是处理一个完整序列的逻辑 ---

            // 将此前缀前的任何常规数据传递下去
            if (prefixIndex > 0) {
                super.feedFromSession(this.internalBuffer.subarray(0, prefixIndex))
            }
            
            const [closesSuffix, closestSuffixRelativeIndex] = suffixMatches[0]
            const closestSuffixIndex = prefixIndex + OSCPrefix.length + closestSuffixRelativeIndex

            const params = this.internalBuffer.subarray(prefixIndex + OSCPrefix.length, closestSuffixIndex)
            const oscString = params.toString()
            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=')[1]
                    if (reportedCWD.startsWith('~')) {
                        reportedCWD = os.homedir() + reportedCWD.substring(1)
                    }
                    this.cwdReported.next(reportedCWD)
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else if (oscCode === 52) {
                if (oscParams[0] === 'c' || oscParams[0] === '') {
                    const content = Buffer.from(oscParams[1], 'base64')
                    this.copyRequested.next(content.toString())
                }
            }
            
            // 从缓冲区中移除已处理的完整序列
            this.internalBuffer = this.internalBuffer.subarray(closestSuffixIndex + closesSuffix.length)
            
            if (this.internalBuffer.length > 0) {
                continueProcessing = true
            }
        } // --- while 循环到此结束 ---

        // ======================================================================
        // (新增的关键步骤) 在这里处理循环结束后缓冲区中剩余的数据，防止延迟
        // ======================================================================
        const remainingPrefixIndex = this.internalBuffer.indexOf(OSCPrefix)

        if (remainingPrefixIndex === -1) {
            // 如果剩余数据中完全没有OSC前缀，说明都是常规数据，全部传递下去
            if (this.internalBuffer.length > 0) {
                super.feedFromSession(this.internalBuffer)
                this.internalBuffer = Buffer.alloc(0)
            }
        } else {
            // 如果剩余数据中有一个OSC前缀（必然是不完整的序列）
            // 则把这个不完整序列之前的所有数据都传递下去
            if (remainingPrefixIndex > 0) {
                super.feedFromSession(this.internalBuffer.subarray(0, remainingPrefixIndex))
                this.internalBuffer = this.internalBuffer.subarray(remainingPrefixIndex)
            }
            // 只把那个不完整的OSC序列本身留在缓冲区里，等待下一次数据
        }
    }

    close (): void {
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }
}
