from collections.abc import Iterable


def get_child(children: Iterable[str]) -> str:
    count = 0
    for child in children:
        count += 1
        if count > 1:
            print("Warning: multiple children found")
            break
    else:
        raise ValueError("No children found")
    return child
