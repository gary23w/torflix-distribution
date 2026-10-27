cask "torflix" do
  arch arm: "arm64", intel: "x64"

  version "0.3.0"
  sha256 arm:   "a1207650d14e204210b1f4a541d735a04f4db45fd33e5dfd6036ac9ab22cf0a3",
         intel: "ef587d039ee36c67916deb56db5f1262cf8b797c5b3f24a04949bfac8591de29"

  url "https://github.com/gary23w/torflix/releases/download/v#{version}/Torflix-#{version}-mac-#{arch}.dmg"
  name "Torflix"
  desc "Stream torrent videos while they download"
  homepage "https://github.com/gary23w/torflix"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Torflix.app"

  zap trash: [
    "~/Library/Application Support/Torflix",
    "~/Library/Preferences/io.torflix.app.plist",
    "~/Library/Saved Application State/io.torflix.app.savedState",
  ]

  caveats <<~EOS
    Torflix is not notarized by Apple, so macOS blocks its first start.
    Open System Settings > Privacy & Security and click Open Anyway.
  EOS
end
