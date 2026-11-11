// Encodes a PNG frame sequence (+ optional WAV) into an H.264/AAC MP4 with AVFoundation.
//
//   swiftc -O docs/promo/encode.swift -o /tmp/gp-encode
//   /tmp/gp-encode <framesDir> <audio.wav|-> <out.mp4> [fps=30] [bitrate=12000000]
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let argv = CommandLine.arguments
guard argv.count >= 4 else {
  FileHandle.standardError.write("usage: encode <framesDir> <audio.wav|-> <out.mp4> [fps] [bitrate]\n".data(using: .utf8)!)
  exit(2)
}
let framesDir = URL(fileURLWithPath: argv[1])
let audioPath = argv[2]
let outURL = URL(fileURLWithPath: argv[3])
let fps = Int32(argv.count > 4 ? Int(argv[4])! : 30)
let bitrate = argv.count > 5 ? Int(argv[5])! : 12_000_000

let frames = try FileManager.default.contentsOfDirectory(at: framesDir, includingPropertiesForKeys: nil)
  .filter { $0.pathExtension == "png" }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }
guard let first = frames.first,
      let src0 = CGImageSourceCreateWithURL(first as CFURL, nil),
      let img0 = CGImageSourceCreateImageAtIndex(src0, 0, nil) else {
  fatalError("no frames in \(framesDir.path)")
}
let width = img0.width, height = img0.height
try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)

let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: bitrate,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
    AVVideoExpectedSourceFrameRateKey: Int(fps),
  ] as [String: Any],
  AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
  ],
])
videoInput.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
  kCVPixelBufferCGImageCompatibilityKey as String: true,
  kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
])
writer.add(videoInput)

var audioInput: AVAssetWriterInput?
var audioReader: AVAssetReader?
var audioOutput: AVAssetReaderTrackOutput?
if audioPath != "-" {
  let asset = AVURLAsset(url: URL(fileURLWithPath: audioPath))
  let sem = DispatchSemaphore(value: 0)
  var track: AVAssetTrack?
  asset.loadTracks(withMediaType: .audio) { tracks, _ in track = tracks?.first; sem.signal() }
  sem.wait()
  guard let track else { fatalError("no audio track in \(audioPath)") }
  let reader = try AVAssetReader(asset: asset)
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
  ])
  reader.add(out)
  let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: 48_000,
    AVNumberOfChannelsKey: 2,
    AVEncoderBitRateKey: 192_000,
  ])
  input.expectsMediaDataInRealTime = false
  writer.add(input)
  audioInput = input; audioReader = reader; audioOutput = out
}

guard writer.startWriting() else { fatalError("startWriting: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)
audioReader?.startReading()

let group = DispatchGroup()
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

group.enter()
var frameIndex = 0
videoInput.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
  while videoInput.isReadyForMoreMediaData {
    if frameIndex >= frames.count {
      videoInput.markAsFinished(); group.leave(); return
    }
    autoreleasepool {
      let url = frames[frameIndex]
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
            let pool = adaptor.pixelBufferPool else { fatalError("cannot read \(url.path)") }
      var pb: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
      guard let buffer = pb else { fatalError("pixel buffer") }
      CVPixelBufferLockBaseAddress(buffer, [])
      let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                          bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
      CVPixelBufferUnlockBaseAddress(buffer, [])
      let time = CMTime(value: CMTimeValue(frameIndex), timescale: fps)
      if !adaptor.append(buffer, withPresentationTime: time) { fatalError("append frame \(frameIndex): \(String(describing: writer.error))") }
      if frameIndex % 150 == 0 { print("video frame \(frameIndex)/\(frames.count)") }
      frameIndex += 1
    }
  }
}

if let audioInput, let audioOutput {
  group.enter()
  let videoDuration = CMTime(value: CMTimeValue(frames.count), timescale: fps)
  audioInput.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
    while audioInput.isReadyForMoreMediaData {
      guard let sample = audioOutput.copyNextSampleBuffer(),
            CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), videoDuration) < 0 else {
        audioInput.markAsFinished(); group.leave(); return
      }
      audioInput.append(sample)
    }
  }
}

group.wait()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fatalError("writer failed: \(String(describing: writer.error))") }
print("wrote \(outURL.path) — \(frames.count) frames @ \(fps) fps, \(width)x\(height)")
