#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface WorkestraNativeDSP : NSObject

- (instancetype)initWithSampleRate:(double)sampleRate;
- (void)setSampleRate:(double)sampleRate;
- (void)setPerfModeStudio:(BOOL)studio;
- (void)setSectionLevel:(NSString *)section value:(float)value;
- (void)setLayerLevel:(NSString *)section layer:(NSString *)layer value:(float)value;

// Synth A & B (layer 0 = A, layer 1 = B)
- (void)setSynthLayer:(int)layer param:(NSString *)param numberValue:(double)value stringValue:(nullable NSString *)strValue;
- (void)synthNoteOn:(int)layer note:(int)note velocity:(int)vel;
- (void)synthNoteOff:(int)layer note:(int)note;
- (void)synthSustain:(int)layer down:(BOOL)down;
- (void)synthBend:(int)layer semitones:(double)semis;
- (void)synthMod:(int)layer value:(double)value;
- (void)synthAllOff:(int)layer;

// Organ (manual 0 = A, 1 = B)
- (void)setOrganBar:(int)manual index:(int)index level:(int)level;
- (void)setOrganModel:(int)manual model:(NSString *)model;
- (void)setOrganPercOn:(BOOL)on third:(BOOL)third fast:(BOOL)fast;
- (void)setOrganVibMode:(int)mode;
- (void)setOrganDrive:(double)value;
- (void)setOrganRotaryMode:(int)mode;
- (void)organNoteOn:(int)manual note:(int)note;
- (void)organNoteOff:(int)manual note:(int)note;
- (void)organAllOff;

// Test chime
- (void)triggerTestChime;

// Continuous Ambient Drone Pad (key: 0=C .. 11=B, octave: 0 ou 1)
- (void)setContinuousPadPlaying:(BOOL)playing key:(int)key octave:(int)octave;
- (void)setContinuousPadAudioSamplesLeft:(const float *)left right:(const float *)right frameCount:(int)frames sampleRate:(double)sampleRate;
- (void)clearContinuousPadAudioSamples;

// Real-time stereo render (safe for CoreAudio IO thread)
- (void)renderLeft:(float *)left right:(float *)right frameCount:(int)frames sampleRate:(double)sampleRate;
- (float)consumeMeterPeak;
- (float)consumeCpuLoad;

// CoreAudio HAL device management
+ (NSArray<NSDictionary<NSString *, NSString *> *> *)listOutputDevices;
+ (unsigned int)deviceIDForUID:(nullable NSString *)uid;
+ (unsigned int)defaultOutputDeviceID;
+ (int)bufferFrameSizeForDevice:(unsigned int)deviceID;
+ (int)setBufferFrameSize:(int)frames forDevice:(unsigned int)deviceID;
+ (double)sampleRateForDevice:(unsigned int)deviceID;
+ (double)setSampleRate:(double)sampleRate forDevice:(unsigned int)deviceID;

@end

NS_ASSUME_NONNULL_END
