from qwen_realtime.vad import SileroVADFactory


class FakeSileroModel:
    def __init__(self, instance_id: int) -> None:
        self.instance_id = instance_id
        self.reset_count = 0

    def reset_states(self) -> None:
        self.reset_count += 1


def test_silero_factory_gives_each_call_an_independent_recurrent_model():
    loaded: list[FakeSileroModel] = []

    def load_model(*, onnx: bool):
        assert onnx is False
        model = FakeSileroModel(len(loaded))
        loaded.append(model)
        return model

    factory = SileroVADFactory(model_loader=load_model)
    first = factory.create()
    second = factory.create()

    assert first.model is loaded[0]
    assert second.model is loaded[1]
    assert first.model is not second.model
    assert first.model.reset_count == 1
    assert second.model.reset_count == 1

    first.flush()
    assert first.model.reset_count == 2
    assert second.model.reset_count == 1
