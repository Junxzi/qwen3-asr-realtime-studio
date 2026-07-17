from qwen_realtime.alignment import SpeakerActivity, WordTiming, attribute_words


def test_word_uses_largest_speaker_overlap_and_marks_overlap():
    words = [WordTiming("株価", 100, 500, 0.9)]
    activities = [
        SpeakerActivity(0, 450, "speaker_0", 0.95),
        SpeakerActivity(300, 600, "speaker_1", 0.8),
    ]
    result = attribute_words(words, activities)
    assert result[0].speaker == "speaker_0"
    assert result[0].overlap is True
    assert result[0].confidence == 0.9
