#define NOMINMAX
#include "../src/mpc-hc/AAAVSLibrary.h"
#include <cassert>
#include <iostream>
int main() {
    using namespace AAAVSLibrary;
    const auto root=fs::current_path()/(L"fixture-"+std::to_wstring(GetCurrentProcessId()));
    fs::create_directories(root/L"catalog");fs::create_directories(root/L"presets/unique");
    const std::string hash(64,'a');const auto source=root/L"presets/unique/Test.avs";
    {std::ofstream f(source,std::ios::binary);f<<"unchanged preset bytes";}
    const auto old=fs::file_time_type::clock::now()-std::chrono::hours(24);fs::last_write_time(source,old);
    const auto catalog=root/L"catalog/presets.json";
    {std::ofstream f(catalog);f<<"{\"presets\":[{\"sha256\":\""<<hash<<"\",\"canonical_path\":\"presets/unique/Test.avs\"}]}";}
    Rate(root,hash,1);const auto one=root/L"presets/unique/Test [1 stars].avs";
    assert(!fs::exists(source)&&fs::exists(one));assert(Read(one)=="unchanged preset bytes");assert(fs::last_write_time(one)>old);
    Rate(root,hash,5);assert(!fs::exists(one));assert(fs::exists(root/L"presets/unique/Test [5 stars].avs"));
    Rate(root,hash,1);const auto time=fs::last_write_time(one);
    const auto marked=SetNotWorking(root,hash,true);
    rapidjson::Document status;status.Parse(marked.c_str());
    assert(status["notWorking"].GetBool()&&status["rating"].GetInt()==1);
    assert(std::string(status["canonical_path"].GetString())=="presets/unique/Test [1 stars].avs");
    assert(fs::last_write_time(one)==time&&Read(one)=="unchanged preset bytes");
    status.Parse(Read(catalog).c_str());assert(status["presets"][0]["notWorking"].GetBool());
    Rate(root,hash,2);const auto two=root/L"presets/unique/Test [2 stars].avs";
    status.Parse(Read(catalog).c_str());assert(status["presets"][0]["notWorking"].GetBool());
    const auto twoTime=fs::last_write_time(two);SetNotWorking(root,hash,false);
    status.Parse(Read(catalog).c_str());assert(!status["presets"][0]["notWorking"].GetBool());
    assert(status["presets"][0]["rating"].GetInt()==2&&fs::last_write_time(two)==twoTime);
    Rate(root,hash,1);const auto beforeFailure=Read(catalog);const auto beforeFailureTime=fs::last_write_time(one);
    {std::ofstream f(root/L"catalog/presets.json.writing");f<<"occupied transaction";}
    bool failed=false;try{Rate(root,hash,3);}catch(...){failed=true;}assert(failed);
    assert(fs::exists(one)&&!fs::exists(root/L"presets/unique/Test [3 stars].avs"));assert(Read(catalog)==beforeFailure);assert(fs::last_write_time(one)==beforeFailureTime);
    failed=false;try{SetNotWorking(root,hash,true);}catch(...){failed=true;}assert(failed);
    assert(Read(catalog)==beforeFailure&&fs::last_write_time(one)==beforeFailureTime);
    fs::remove(root/L"catalog/presets.json.writing");
    for(const auto& path:{"presets/../escape.avs","C:/escape.avs","presets/unique/test.txt","presets/unique/../../escape.avs"}){failed=false;try{PresetPath(root,path);}catch(...){failed=true;}assert(failed);}
    failed=false;try{Rate(root,hash,0);}catch(...){failed=true;}assert(failed);
    failed=false;try{Rate(root,std::string(64,'b'),3);}catch(...){failed=true;}assert(failed);
    failed=false;try{SetNotWorking(root,std::string(64,'b'),true);}catch(...){failed=true;}assert(failed);
    failed=false;try{SetNotWorking(root,"invalid",true);}catch(...){failed=true;}assert(failed);
    const std::string nervHash(64,'c');const auto nervSource=root/L"presets/unique/NERV 01 - Boot.nerv";
    const std::string manifest="{\"format\":\"mpcaaavs-nerv\",\"version\":1,\"scene\":\"boot\"}";
    {std::ofstream f(nervSource,std::ios::binary);f<<manifest;}fs::last_write_time(nervSource,old);
    rapidjson::Document mixed;mixed.Parse(Read(catalog).c_str());auto& allocator=mixed.GetAllocator();
    rapidjson::Value nerv(rapidjson::kObjectType);
    nerv.AddMember("sha256",rapidjson::Value(nervHash.c_str(),allocator),allocator);
    nerv.AddMember("canonical_path","presets/unique/NERV 01 - Boot.nerv",allocator);
    nerv.AddMember("kind","nerv",allocator);nerv.AddMember("scene","boot",allocator);
    mixed["presets"].PushBack(nerv,allocator);AtomicWrite(catalog,Json(mixed));
    Rate(root,nervHash,4);const auto nervRated=root/L"presets/unique/NERV 01 - Boot [4 stars].nerv";
    assert(!fs::exists(nervSource)&&fs::exists(nervRated));assert(Read(nervRated)==manifest);assert(fs::last_write_time(nervRated)>old);
    Rate(root,nervHash,2);const auto nervTwo=root/L"presets/unique/NERV 01 - Boot [2 stars].nerv";
    assert(!fs::exists(nervRated)&&fs::exists(nervTwo));assert(Read(nervTwo)==manifest);assert(fs::exists(one));
    mixed.Parse(Read(catalog).c_str());assert(mixed["presets"].Size()==2);
    assert(std::string(mixed["presets"][1]["kind"].GetString())=="nerv");assert(std::string(mixed["presets"][1]["scene"].GetString())=="boot");
    const auto nervTime=fs::last_write_time(nervTwo);SetNotWorking(root,nervHash,true);
    mixed.Parse(Read(catalog).c_str());assert(mixed["presets"][1]["notWorking"].GetBool()&&mixed["presets"][1]["rating"].GetInt()==2);
    assert(fs::last_write_time(nervTwo)==nervTime&&Read(nervTwo)==manifest);
    fs::remove(nervTwo);SetNotWorking(root,nervHash,false); // Missing presets remain recoverable in the manager.
    mixed.Parse(Read(catalog).c_str());assert(!mixed["presets"][1]["notWorking"].GetBool());
    std::cout<<"Preset filesystem: AVS/NERV rating rename, timestamp and byte preservation, persistent status/undo, rating-status independence, atomic rollback, mixed catalog, invalid paths and unknown IDs PASS\n";
}
