import Foundation
import AppKit
import Translation

@main
struct RillTranslate {
    static func main() async {
        let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            FileHandle.standardError.write(Data("翻訳する要約がありません\n".utf8))
            exit(2)
        }
        guard #available(macOS 26.0, *) else {
            FileHandle.standardError.write(Data("Appleの翻訳機能にはmacOS 26以降が必要です\n".utf8))
            exit(3)
        }

        do {
            let source = Locale.Language(identifier: "en")
            let target = Locale.Language(identifier: "ja")
            let session: TranslationSession
            if #available(macOS 26.4, *) {
                // Use Apple's dedicated traditional translation model rather than
                // the Apple Intelligence high-fidelity strategy.
                session = TranslationSession(
                    installedSource: source,
                    target: target,
                    preferredStrategy: .lowLatency
                )
            } else {
                session = TranslationSession(installedSource: source, target: target)
            }
            let response = try await session.translate(input)
            FileHandle.standardOutput.write(Data(response.targetText.utf8))
        } catch {
            if let settingsURL = URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension") {
                NSWorkspace.shared.open(settingsURL)
            }
            FileHandle.standardError.write(Data("英語から日本語へ翻訳できませんでした。「言語と地域」を開きました。「翻訳言語」で英語と日本語をダウンロードしてください: \(error.localizedDescription)\n".utf8))
            exit(5)
        }
    }
}
